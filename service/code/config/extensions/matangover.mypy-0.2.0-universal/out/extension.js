"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = exports.mypyOutputPattern = void 0;
const vscode = require("vscode");
const path = require("path");
const crypto = require("crypto");
const child_process_promise_1 = require("child-process-promise");
const fs = require("fs");
const lookpath_1 = require("lookpath");
const untildify = require("untildify");
const semver = require("semver");
const shlex_1 = require("shlex");
const AsyncLock = require("async-lock");
const allSettled = require("promise.allsettled");
const diagnostics = new Map();
const outputChannel = vscode.window.createOutputChannel('Mypy');
let _context;
let lock = new AsyncLock();
let statusBarItem;
let activeChecks = 0;
let checkIndex = 1;
const pythonExtensionInitialized = new Set();
let activated = false;
const DEBUG = false;
exports.mypyOutputPattern = /^(?<file>[^:\n]+):((?<line>\d+):)?((?<column>\d+):)? (?<type>\w+): (?<message>.*)$/mg;
function activate(context) {
    return __awaiter(this, void 0, void 0, function* () {
        activated = true;
        _context = context;
        context.subscriptions.push(outputChannel);
        const previousVersion = context.globalState.get('extensionVersion');
        let upgradedFromMypyls = false;
        if (previousVersion && semver.valid(previousVersion) && semver.lt(previousVersion, '0.2.0')) {
            upgradedFromMypyls = true;
        }
        const extension = vscode.extensions.getExtension('matangover.mypy');
        const currentVersion = extension === null || extension === void 0 ? void 0 : extension.packageJSON.version;
        context.globalState.update('extensionVersion', currentVersion);
        output(`Mypy extension activated, version ${currentVersion}`);
        if ((extension === null || extension === void 0 ? void 0 : extension.extensionKind) === vscode.ExtensionKind.Workspace) {
            output('Running remotely');
        }
        statusBarItem = vscode.window.createStatusBarItem();
        context.subscriptions.push(statusBarItem);
        statusBarItem.text = "$(gear~spin) mypy";
        output('Registering listener for interpreter changed event');
        const pythonExtension = yield getPythonExtension(undefined);
        if (pythonExtension !== undefined) {
            if (pythonExtension.exports.settings.onDidChangeExecutionDetails) {
                const handler = pythonExtension.exports.settings.onDidChangeExecutionDetails(activeInterpreterChanged);
                context.subscriptions.push(handler);
                output('Listener registered');
            }
        }
        // TODO: add 'Mypy: recheck workspace' command.
        yield migrateDeprecatedSettings(vscode.workspace.workspaceFolders);
        if (upgradedFromMypyls) {
            output('Extension upgraded, migrating settings');
            yield migrateDefaultMypylsToDmypy();
        }
        yield forEachFolder(vscode.workspace.workspaceFolders, folder => checkWorkspace(folder.uri));
        context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(workspaceFoldersChanged), vscode.workspace.onDidSaveTextDocument(documentSaved), vscode.workspace.onDidDeleteFiles(filesDeleted), vscode.workspace.onDidRenameFiles(filesRenamed), vscode.workspace.onDidCreateFiles(filesCreated), vscode.workspace.onDidChangeConfiguration(configurationChanged));
    });
}
exports.activate = activate;
function migrateDeprecatedSettings(folders) {
    return __awaiter(this, void 0, void 0, function* () {
        const migration = { needed: false, failed: [] };
        // Migrate workspace folder settings.
        if (folders !== undefined) {
            for (let folder of folders) {
                yield migrate(folder, vscode.ConfigurationTarget.WorkspaceFolder, migration, `settings for workspace folder '${folder.name}'`);
            }
        }
        // Migrate workspace settings.
        yield migrate(null, vscode.ConfigurationTarget.Workspace, migration, 'workspace settings');
        // Migrate user settings.
        yield migrate(null, vscode.ConfigurationTarget.Global, migration, 'user settings');
        if (migration.needed) {
            if (migration.failed.length == 0) {
                vscode.window.showInformationMessage('The Mypy extension now uses the mypy daemon (dmypy) instead of mypyls. ' +
                    'Your mypy.executable settings have been migrated to the new setting: ' +
                    'mypy.dmypyExecutable.');
            }
            else {
                vscode.window.showInformationMessage('The Mypy extension now uses the mypy daemon (dmypy) instead of mypyls. ' +
                    'Please use the new mypy.dmypyExecutable setting instead of mypy.executable. ' +
                    'The deprecated mypy.executable setting was found in: ' +
                    migration.failed.join(", ") + '.');
            }
        }
    });
}
function migrate(scope, target, migration, targetLabel) {
    return __awaiter(this, void 0, void 0, function* () {
        const config = vscode.workspace.getConfiguration('mypy', scope);
        const dmypySetting = config.inspect('dmypyExecutable');
        const existingDmypy = getValue(dmypySetting, target);
        if (existingDmypy !== undefined) {
            return;
        }
        const mypylsSetting = config.inspect('executable');
        const mypylsExecutable = getValue(mypylsSetting, target);
        if (mypylsExecutable === undefined) {
            return;
        }
        migration.needed = true;
        const dmypyExecutable = getDmypyExecutableFromMypyls(mypylsExecutable);
        let dmypyExecutableExpanded = untildify(dmypyExecutable);
        if (scope !== null) {
            dmypyExecutableExpanded = dmypyExecutableExpanded.replace('${workspaceFolder}', scope.uri.fsPath);
        }
        if (fs.existsSync(dmypyExecutableExpanded)) {
            yield config.update('dmypyExecutable', dmypyExecutable, target);
            yield config.update('executable', undefined, target);
        }
        else {
            migration.failed.push(targetLabel);
        }
    });
}
function migrateDefaultMypylsToDmypy() {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const dmypyUserSetting = (_a = vscode.workspace.getConfiguration("mypy").inspect("dmypyExecutable")) === null || _a === void 0 ? void 0 : _a.globalValue;
        if (dmypyUserSetting !== undefined) {
            // dmypyExecutable is already defined in User settings. Do nothing.
            return;
        }
        const dmypyInPath = (yield lookpath_1.lookpath('dmypy')) !== undefined;
        if (dmypyInPath) {
            // dmypy is available on PATH. Notify user and do nothing.
            vscode.window.showInformationMessage('The Mypy extension has been updated. It will now use the mypy daemon (found on your ' +
                'PATH) instead of the mypy language server.');
            return;
        }
        const mypyls = getDefaultMypylsExecutable();
        let dmypyFound = false;
        if (fs.existsSync(mypyls)) {
            // mypyls is installed in the default location, try using dmypy from the mypyls
            // installation.
            const dmypyExecutable = getDmypyExecutableFromMypyls(mypyls);
            output(`Dmypy guess: ${dmypyExecutable}`);
            if (fs.existsSync(dmypyExecutable)) {
                yield vscode.workspace.getConfiguration('mypy').update('dmypyExecutable', dmypyExecutable, vscode.ConfigurationTarget.Global);
                dmypyFound = true;
            }
        }
        if (!dmypyFound) {
            vscode.window.showInformationMessage('The Mypy extension has been updated. It now uses the mypy daemon (dmypy), however dmypy ' +
                'was not found on your system. Please install mypy on your PATH or change the ' +
                'mypy.dmypyExecutable setting.');
        }
    });
}
function getDefaultMypylsExecutable() {
    let executable = (process.platform === 'win32') ?
        '~\\.mypyls\\Scripts\\mypyls.exe' :
        '~/.mypyls/bin/mypyls';
    return untildify(executable);
}
function getValue(config, target) {
    if (config === undefined) {
        // Configuration does not exist.
        return undefined;
    }
    else if (target == vscode.ConfigurationTarget.Global) {
        return config.globalValue;
    }
    else if (target == vscode.ConfigurationTarget.Workspace) {
        return config.workspaceValue;
    }
    else if (target == vscode.ConfigurationTarget.WorkspaceFolder) {
        return config.workspaceFolderValue;
    }
}
function deactivate() {
    return __awaiter(this, void 0, void 0, function* () {
        activated = false;
        output(`Mypy extension deactivating, shutting down daemons...`);
        yield forEachFolder(vscode.workspace.workspaceFolders, folder => stopDaemon(folder.uri));
        output(`Mypy daemons stopped, extension deactivated`);
    });
}
exports.deactivate = deactivate;
function workspaceFoldersChanged(e) {
    return __awaiter(this, void 0, void 0, function* () {
        const format = (folders) => folders.map(f => f.name).join(", ") || "none";
        output(`Workspace folders changed. Added: ${format(e.added)}. Removed: ${format(e.removed)}.`);
        yield forEachFolder(e.removed, (folder) => __awaiter(this, void 0, void 0, function* () {
            var _a;
            yield stopDaemon(folder.uri);
            (_a = diagnostics.get(folder.uri)) === null || _a === void 0 ? void 0 : _a.dispose();
            diagnostics.delete(folder.uri);
            pythonExtensionInitialized.delete(folder.uri);
        }));
        yield migrateDeprecatedSettings(e.added);
        yield forEachFolder(e.added, folder => checkWorkspace(folder.uri));
    });
}
function forEachFolder(folders, func, ignoreErrors = true) {
    return __awaiter(this, void 0, void 0, function* () {
        if (folders === undefined) {
            return;
        }
        // Run the function for each callback, and catch errors if any.
        // Use allSettled instead of Promise.all to always await all Promises, even if one rejects.
        const promises = folders.map(func);
        const results = yield allSettled(promises);
        if (ignoreErrors) {
            return;
        }
        const rejections = results.filter(r => r.status === "rejected");
        const errors = rejections.map(r => r.reason);
        if (errors.length > 0) {
            throw errors;
        }
    });
}
function stopDaemon(folder, retry = true) {
    return __awaiter(this, void 0, void 0, function* () {
        output(`Stop daemon: ${folder.fsPath}`);
        const result = yield runDmypy(folder, 'stop');
        if (result.success) {
            output(`Stopped daemon: ${folder.fsPath}`);
        }
        else {
            if (retry) {
                // Daemon stopping can fail with 'Status file not found' if the daemon has been started
                // very recently and hasn't written the status file yet. In that case, retry, otherwise
                // we might leave a zombie daemon running. This happened due to the following events:
                // 1. Open folder in VS Code, and then add another workspace folder
                // 2. VS Code fires onDidChangeWorkspaceFolders and onDidChangeConfiguration, which
                //	  causes us to queue two checks. (This is probably a bug in VS Code.)
                // 3. VS Code immediately restarts the Extension Host process, which causes our
                //    extension to deactivate.
                // 4. We try to stop the daemon but it is not yet running. We then start the daemon
                //    because of the queued check(s), which results in a zombie daemon.
                // This simple retry solves the issue.
                output(`Daemon stopping failed, retrying in 1 second: ${folder.fsPath}`);
                yield sleep(1000);
                yield stopDaemon(folder, false);
            }
            else {
                output(`Daemon stopping failed again, giving up: ${folder.fsPath}`);
            }
        }
    });
}
function runDmypy(folder, dmypyCommand, mypyArgs = [], warnIfFailed = false, successfulExitCodes, addPythonExecutableArgument = false, currentCheck) {
    return __awaiter(this, void 0, void 0, function* () {
        let dmypyGlobalArgs = [];
        let dmypyCommandArgs = [];
        // Store the dmypy status file in the extension's workspace storage folder, instead of the
        // default location which is .dmypy.json in the cwd.
        if ((_context === null || _context === void 0 ? void 0 : _context.storageUri) !== undefined) {
            fs.mkdirSync(_context.storageUri.fsPath, { recursive: true });
            const folderHash = crypto.createHash('sha1').update(folder.toString()).digest('hex');
            const statusFileName = `dmypy-${folderHash}.json`;
            const statusFilePath = path.join(_context.storageUri.fsPath, statusFileName);
            dmypyGlobalArgs = ["--status-file", statusFilePath];
            const commandsSupportingLog = ["start", "restart", "run"];
            if (commandsSupportingLog.includes(dmypyCommand)) {
                const logFileName = `dmypy-${folderHash}.log`;
                const logFilePath = path.join(_context.storageUri.fsPath, logFileName);
                dmypyCommandArgs = ['--log-file', logFilePath];
            }
        }
        const activeInterpreter = yield getActiveInterpreter(folder, currentCheck);
        const mypyConfig = vscode.workspace.getConfiguration('mypy', folder);
        let executable;
        const runUsingActiveInterpreter = mypyConfig.get('runUsingActiveInterpreter');
        let executionArgs = [];
        if (runUsingActiveInterpreter) {
            executable = activeInterpreter;
            executionArgs = ["-m", "mypy.dmypy"];
            if (executable === undefined) {
                warn("Could not run mypy: no active interpreter. Please activate an interpreter or " +
                    "switch off the mypy.runUsingActiveInterpreter setting.", warnIfFailed, currentCheck);
            }
        }
        else {
            executable = yield getDmypyExecutable(folder, warnIfFailed, currentCheck);
        }
        if (executable === undefined) {
            return { success: false, stdout: null };
        }
        if (addPythonExecutableArgument && activeInterpreter) {
            mypyArgs = [...mypyArgs, '--python-executable', activeInterpreter];
        }
        const args = [...executionArgs, ...dmypyGlobalArgs, dmypyCommand, ...dmypyCommandArgs];
        if (mypyArgs.length > 0) {
            args.push("--", ...mypyArgs);
        }
        const command = [executable, ...args].map(shlex_1.quote).join(" ");
        output(`Running dmypy in folder ${folder.fsPath}\n${command}`, currentCheck);
        try {
            const result = yield child_process_promise_1.spawn(executable, args, {
                cwd: folder.fsPath,
                capture: ['stdout', 'stderr'],
                successfulExitCodes
            });
            if (result.code == 1 && result.stderr) {
                // This might happen when running using `python -m mypy.dmypy` and some error in the
                // interpreter occurs, such as import error when mypy is not installed.
                let error = '';
                if (runUsingActiveInterpreter) {
                    error = 'Probably mypy is not installed in the active interpreter ' +
                        `(${activeInterpreter}). Either install mypy in this interpreter or switch ` +
                        'off the mypy.runUsingActiveInterpreter setting. ';
                }
                warn(`Error running mypy in ${folder.fsPath}. ${error}See Output panel for details.`, warnIfFailed, currentCheck, true);
                if (result.stdout) {
                    output(`stdout:\n${result.stdout}`, currentCheck);
                }
                output(`stderr:\n${result.stderr}`, currentCheck);
                return { success: false, stdout: result.stdout };
            }
            return { success: true, stdout: result.stdout };
        }
        catch (exception) {
            let error = exception.toString();
            let showDetailsButton = false;
            if (exception.name === 'ChildProcessError') {
                const ex = exception;
                if (ex.code !== undefined) {
                    let errorString;
                    if (ex.stderr) {
                        // Show only first line of error to user because Newlines are stripped in VSCode
                        // warning messages and it can appear confusing.
                        let mypyError = ex.stderr.split("\n")[0];
                        if (mypyError.length > 300) {
                            mypyError = mypyError.slice(0, 300) + " [...]";
                        }
                        errorString = `error: "${mypyError}"`;
                    }
                    else {
                        errorString = `exit code ${ex.code}`;
                    }
                    error = `mypy failed with ${errorString}. See Output panel for details.`;
                    showDetailsButton = true;
                }
                if (ex.stdout) {
                    if (ex.code == 2 && !ex.stderr) {
                        // Mypy considers syntax errors as fatal errors (exit code 2). The daemon's
                        // exit code is inconsistent in this case (e.g. for syntax errors it can return
                        // either 1 or 2).
                        return { success: true, stdout: ex.stdout };
                    }
                    output(`stdout:\n${ex.stdout}`, currentCheck);
                }
                if (ex.stderr) {
                    output(`stderr:\n${ex.stderr}`, currentCheck);
                    if (ex.stderr.indexOf('Daemon crashed!') != -1) {
                        error = 'the mypy daemon crashed. This is probably a bug in mypy itself, ' +
                            'see Output panel for details. The daemon will be restarted automatically.';
                        showDetailsButton = true;
                    }
                    else if (ex.stderr.indexOf('There are no .py[i] files in directory') != -1) {
                        // Swallow this error. This may happen if one workspace folder contains
                        // Python files and another folder doesn't, or if a workspace contains Python
                        // files that are not reachable from the target directory.
                        return { success: true, stdout: '' };
                    }
                }
            }
            warn(`Error running mypy in ${folder.fsPath}: ${error}`, warnIfFailed, currentCheck, showDetailsButton);
            return { success: false, stdout: null };
        }
    });
}
function getDmypyExecutable(folder, warnIfFailed, currentCheck) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const mypyConfig = vscode.workspace.getConfiguration('mypy', folder);
        let dmypyExecutable = (_a = mypyConfig.get('dmypyExecutable')) !== null && _a !== void 0 ? _a : 'dmypy';
        const isCommand = path.parse(dmypyExecutable).dir === '';
        if (isCommand) {
            const executable = yield lookpath_1.lookpath(dmypyExecutable);
            if (executable === undefined) {
                warn(`The mypy daemon executable ('${dmypyExecutable}') was not found on your PATH. ` +
                    `Please install mypy or adjust the mypy.dmypyExecutable setting.`, warnIfFailed, currentCheck);
                return undefined;
            }
            dmypyExecutable = executable;
        }
        else {
            dmypyExecutable = untildify(dmypyExecutable).replace('${workspaceFolder}', folder.fsPath);
            if (!fs.existsSync(dmypyExecutable)) {
                warn(`The mypy daemon executable ('${dmypyExecutable}') was not found. ` +
                    `Please install mypy or adjust the mypy.dmypyExecutable setting.`, warnIfFailed, currentCheck);
                return undefined;
            }
        }
        return dmypyExecutable;
    });
}
function documentSaved(document) {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) {
        return;
    }
    if (document.languageId == "python" || isMaybeConfigFile(folder, document.fileName)) {
        output(`Document saved: ${document.uri.fsPath}`);
        checkWorkspace(folder.uri);
    }
}
function isMaybeConfigFile(folder, file) {
    if (isConfigFileName(file)) {
        return true;
    }
    let configFile = vscode.workspace.getConfiguration("mypy", folder).get("configFile");
    if (configFile === undefined) {
        return false;
    }
    if (!path.isAbsolute(configFile)) {
        configFile = path.join(folder.uri.fsPath, configFile);
    }
    return path.normalize(configFile) == path.normalize(file);
}
function isConfigFileName(file) {
    const name = path.basename(file);
    return name == "mypy.ini" || name == ".mypy.ini" || name == "setup.cfg" || name == "config";
}
function configurationChanged(event) {
    var _a;
    const folders = (_a = vscode.workspace.workspaceFolders) !== null && _a !== void 0 ? _a : [];
    const affectedFolders = folders.filter(folder => (event.affectsConfiguration("mypy", folder) ||
        event.affectsConfiguration("python.pythonPath", folder)));
    const affectedFoldersString = affectedFolders.map(f => f.uri.fsPath).join(", ");
    output(`Mypy settings changed: ${affectedFoldersString}`);
    forEachFolder(affectedFolders, folder => checkWorkspace(folder.uri));
}
function checkWorkspace(folder) {
    return __awaiter(this, void 0, void 0, function* () {
        // Don't check the same workspace folder more than once at the same time.
        yield lock.acquire(folder.fsPath, () => checkWorkspaceInternal(folder));
    });
}
function checkWorkspaceInternal(folder) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        if (!activated) {
            // This can happen if a check was queued right before the extension was deactivated.
            // We don't want to check in that case since it would cause a zombie daemon.
            output(`Extension is not activated, not checking: ${folder.fsPath}`);
            return;
        }
        statusBarItem.show();
        activeChecks++;
        const currentCheck = checkIndex;
        checkIndex++;
        output(`Check workspace: ${folder.fsPath}`, currentCheck);
        const mypyConfig = vscode.workspace.getConfiguration("mypy", folder);
        let targets = mypyConfig.get("targets", []);
        const mypyArgs = [...targets, '--show-column-numbers', '--no-error-summary', '--no-pretty', '--no-color-output'];
        const configFile = mypyConfig.get("configFile");
        if (configFile) {
            output(`Using config file: ${configFile}`, currentCheck);
            mypyArgs.push('--config-file', configFile);
        }
        const result = yield runDmypy(folder, 'run', mypyArgs, true, [0, 1], true, currentCheck);
        activeChecks--;
        if (activeChecks == 0) {
            statusBarItem.hide();
        }
        if (result.stdout !== null) {
            output(`Mypy output:\n${(_a = result.stdout) !== null && _a !== void 0 ? _a : "\n"}`, currentCheck);
        }
        const diagnostics = getWorkspaceDiagnostics(folder);
        diagnostics.clear();
        if (result.success && result.stdout) {
            let fileDiagnostics = new Map();
            let match;
            while ((match = exports.mypyOutputPattern.exec(result.stdout)) !== null) {
                const groups = match.groups;
                const fileUri = vscode.Uri.file(path.join(folder.fsPath, groups.file));
                if (!fileDiagnostics.has(fileUri)) {
                    fileDiagnostics.set(fileUri, []);
                }
                const thisFileDiagnostics = fileDiagnostics.get(fileUri);
                const line = parseInt(groups.line) - 1;
                const column = parseInt(groups.column || '1') - 1;
                const diagnostic = new vscode.Diagnostic(new vscode.Range(line, column, line, column), groups.message, groups.type === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Information);
                diagnostic.source = 'mypy';
                thisFileDiagnostics.push(diagnostic);
            }
            diagnostics.set(Array.from(fileDiagnostics.entries()));
        }
    });
}
function getWorkspaceDiagnostics(folder) {
    let workspaceDiagnostics = diagnostics.get(folder);
    if (workspaceDiagnostics) {
        return workspaceDiagnostics;
    }
    else {
        const workspaceDiagnostics = vscode.languages.createDiagnosticCollection('mypy');
        diagnostics.set(folder, workspaceDiagnostics);
        _context.subscriptions.push(workspaceDiagnostics);
        return workspaceDiagnostics;
    }
}
function getActiveInterpreter(folder, currentCheck) {
    return __awaiter(this, void 0, void 0, function* () {
        let path = yield getPythonPathFromPythonExtension(folder, currentCheck);
        if (path === undefined) {
            path = vscode.workspace.getConfiguration('python', folder).get('pythonPath');
            output(`Using python.pythonPath: ${path}`, currentCheck);
            if (!path) {
                path = undefined;
            }
        }
        return path;
    });
}
// The VS Code Python extension manages its own internal store of configuration settings.
// The setting that was traditionally named "python.pythonPath" has been moved to the
// Python extension's internal store. This function is mostly taken from pyright.
function getPythonPathFromPythonExtension(scopeUri, currentCheck) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const extension = yield getPythonExtension(currentCheck);
            if (extension === undefined) {
                return;
            }
            const execDetails = yield extension.exports.settings.getExecutionDetails(scopeUri);
            let result;
            if (execDetails.execCommand && execDetails.execCommand.length > 0) {
                result = execDetails.execCommand[0];
            }
            if (result === "python" && !pythonExtensionInitialized.has(scopeUri)) {
                // There is a bug in the Python extension which returns sometimes 'python'
                // while the extension is initializing. This can cause ugly errors when the mypy
                // extension runs before the interpreter is initialized.
                // See https://github.com/microsoft/vscode-python/issues/15467
                // Give the Python extension 5 more seconds to properly load (hopefully).
                output(`Got 'python' as Python path, giving the Python extension 5 more seconds to load`, currentCheck);
                yield sleep(5000);
                pythonExtensionInitialized.add(scopeUri);
                return getPythonPathFromPythonExtension(scopeUri, currentCheck);
            }
            else {
                pythonExtensionInitialized.add(scopeUri);
            }
            output(`Received python path from Python extension: ${result}`, currentCheck);
            return result;
        }
        catch (error) {
            output(`Exception when reading python path from Python extension: ${JSON.stringify(error)}`, currentCheck);
        }
        return undefined;
    });
}
function activeInterpreterChanged(resource) {
    var _a;
    output(`Active interpreter changed for resource: ${resource === null || resource === void 0 ? void 0 : resource.fsPath}`);
    if (resource === undefined) {
        (_a = vscode.workspace.workspaceFolders) === null || _a === void 0 ? void 0 : _a.map(folder => checkWorkspace(folder.uri));
    }
    else {
        const folder = vscode.workspace.getWorkspaceFolder(resource);
        if (folder) {
            checkWorkspace(folder.uri);
        }
    }
}
function getPythonExtension(currentCheck) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        const extension = vscode.extensions.getExtension('ms-python.python');
        if (!extension) {
            output('Python extension not found', currentCheck);
            return undefined;
        }
        if (!((_b = (_a = extension.packageJSON) === null || _a === void 0 ? void 0 : _a.featureFlags) === null || _b === void 0 ? void 0 : _b.usingNewInterpreterStorage)) {
            return undefined;
        }
        if (!extension.isActive) {
            output('Waiting for Python extension to load', currentCheck);
            yield extension.activate();
            output('Python extension loaded', currentCheck);
        }
        return extension;
    });
}
function warn(warning, show = false, currentCheck, detailsButton = false) {
    return __awaiter(this, void 0, void 0, function* () {
        output(warning, currentCheck);
        if (show) {
            const items = detailsButton ? ["Details"] : [];
            const result = yield vscode.window.showWarningMessage(warning, ...items);
            if (result === "Details") {
                outputChannel.show();
            }
        }
    });
}
function filesDeleted(e) {
    return __awaiter(this, void 0, void 0, function* () {
        yield filesChanged(e.files);
    });
}
function filesRenamed(e) {
    return __awaiter(this, void 0, void 0, function* () {
        const changedUris = e.files.map(f => f.oldUri).concat(...e.files.map(f => f.newUri));
        yield filesChanged(changedUris);
    });
}
function filesCreated(e) {
    return __awaiter(this, void 0, void 0, function* () {
        yield filesChanged(e.files, true);
    });
}
function filesChanged(files, created = false) {
    return __awaiter(this, void 0, void 0, function* () {
        const folders = new Set();
        for (let file of files) {
            const folder = vscode.workspace.getWorkspaceFolder(file);
            if (folder === undefined)
                continue;
            const path = file.fsPath;
            if (path.endsWith(".py") || path.endsWith(".pyi")) {
                folders.add(folder.uri);
            }
            else if (isMaybeConfigFile(folder, path)) {
                // Don't trigger mypy run if config file has just been created and is empty, because
                // mypy would error. Give the user a chance to edit the file.
                const justCreatedAndEmpty = created && fs.statSync(path).size === 0;
                if (!justCreatedAndEmpty) {
                    folders.add(folder.uri);
                }
            }
        }
        if (folders.size === 0) {
            return;
        }
        const foldersString = Array.from(folders).map(f => f.fsPath).join(", ");
        output(`Files changed in folders: ${foldersString}`);
        yield forEachFolder(Array.from(folders), folder => checkWorkspace(folder));
    });
}
function output(line, currentCheck) {
    if (currentCheck !== undefined) {
        line = `[${currentCheck}] ${line}`;
    }
    if (DEBUG) {
        var tzoffset = (new Date()).getTimezoneOffset() * 60000;
        var localISOTime = (new Date(Date.now() - tzoffset)).toISOString().slice(0, -1);
        fs.appendFileSync("/tmp/log.txt", `${localISOTime} [${process.pid}] ${line}\n`);
    }
    outputChannel.appendLine(line);
}
function getDmypyExecutableFromMypyls(mypylsExecutable) {
    const name = (process.platform === 'win32') ? 'dmypy.exe' : 'dmypy';
    return path.join(path.dirname(mypylsExecutable), name);
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//# sourceMappingURL=extension.js.map