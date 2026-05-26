import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { _ as sleep } from "./utils-sBTEdeml.js";
import { f as resolveGatewayServiceDescription, m as resolveGatewayWindowsTaskName } from "./constants-CmvvKVqh.js";
import { t as resolveGatewayStateDir } from "./paths-Bq0Y-b28.js";
import { t as getWindowsInstallRoots } from "./windows-install-roots-C-V7Ai9d.js";
import { o as inspectPortUsage } from "./ports-C3z_VZTO.js";
import { t as isGatewayArgv } from "./gateway-process-argv-0KsxsGrA.js";
import { a as renderCmdSetAssignment, i as parseCmdSetAssignment, n as quoteCmdScriptArg, r as assertNoCmdLineBreak, t as parseCmdScriptCommandLine } from "./cmd-argv-fj4pRVR6.js";
import { i as writeFormattedLines, n as formatLine, t as parseKeyValueOutput } from "./runtime-parse-kPUd4M9k.js";
import { t as findVerifiedGatewayListenerPidsOnPortSync } from "./gateway-processes-DtC5jd3t.js";
import { t as killProcessTree } from "./kill-tree-C3duXFqv.js";
import { t as execSchtasks } from "./schtasks-exec-DaVAzDNM.js";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
//#region src/daemon/schtasks.ts
function resolveTaskName(env) {
	const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
	if (override) return override;
	return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}
function shouldFallbackToStartupEntry(params) {
	return params.code === 1 || /(?:access is denied|acceso denegado)/i.test(params.detail) || params.code === 124 || /schtasks timed out/i.test(params.detail) || /schtasks produced no output/i.test(params.detail);
}
function resolveTaskScriptPath(env) {
	const override = env.OPENCLAW_TASK_SCRIPT?.trim();
	if (override) return override;
	const scriptName = env.OPENCLAW_TASK_SCRIPT_NAME?.trim() || "gateway.cmd";
	if (/[/\\]|\.\./.test(scriptName)) throw new Error(`OPENCLAW_TASK_SCRIPT_NAME must be a file name only, not a path: ${scriptName}`);
	const stateDir = resolveGatewayStateDir(env);
	return path.join(stateDir, scriptName);
}
function resolveWindowsStartupDir(env) {
	const appData = env.APPDATA?.trim();
	if (appData) return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
	const home = env.USERPROFILE?.trim() || env.HOME?.trim();
	if (!home) throw new Error("Windows startup folder unavailable: APPDATA/USERPROFILE not set");
	return path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}
function sanitizeWindowsFilename(value) {
	return value.replace(/[<>:"/\\|?*]/g, "_").replace(/\p{Cc}/gu, "_");
}
function resolveStartupEntryPath(env, extension) {
	const taskName = resolveTaskName(env);
	const entryExtension = extension ?? (shouldUseHiddenWindowsTaskLauncher(env) ? "vbs" : "cmd");
	return path.join(resolveWindowsStartupDir(env), `${sanitizeWindowsFilename(taskName)}.${entryExtension}`);
}
function resolveStartupEntryPaths(env) {
	const primaryPath = resolveStartupEntryPath(env);
	const legacyCmdPath = resolveStartupEntryPath(env, "cmd");
	return Array.from(new Set([primaryPath, legacyCmdPath]));
}
function quoteSchtasksArg(value) {
	if (!/[ \t"]/g.test(value)) return value;
	return `"${value.replace(/"/g, "\\\"")}"`;
}
function resolveTaskUser(env) {
	const username = env.USERNAME || env.USER || env.LOGNAME;
	if (!username) return null;
	if (username.includes("\\")) return username;
	const domain = env.USERDOMAIN;
	if (domain) return `${domain}\\${username}`;
	return username;
}
function shouldUseHiddenWindowsTaskLauncher(env) {
	const value = normalizeLowercaseStringOrEmpty(env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER);
	return value === "1" || value === "true" || value === "yes";
}
function resolveTaskLauncherScriptPath(env, scriptPath) {
	if (!shouldUseHiddenWindowsTaskLauncher(env)) return scriptPath;
	const parsed = path.parse(scriptPath);
	return path.join(parsed.dir, `${parsed.name}.vbs`);
}
async function readScheduledTaskCommand(env) {
	const scriptPath = resolveTaskScriptPath(env);
	try {
		const content = await fs.readFile(scriptPath, "utf8");
		let workingDirectory = "";
		let commandLine = "";
		const environment = {};
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line) continue;
			const lower = normalizeLowercaseStringOrEmpty(line);
			if (line.startsWith("@echo")) continue;
			if (lower.startsWith("rem ")) continue;
			if (lower.startsWith("set ")) {
				const assignment = parseCmdSetAssignment(line.slice(4));
				if (assignment) environment[assignment.key] = assignment.value;
				continue;
			}
			if (lower.startsWith("cd /d ")) {
				workingDirectory = line.slice(6).trim().replace(/^"|"$/g, "");
				continue;
			}
			commandLine = line;
			break;
		}
		if (!commandLine) return null;
		return {
			programArguments: parseCmdScriptCommandLine(commandLine),
			...workingDirectory ? { workingDirectory } : {},
			...Object.keys(environment).length > 0 ? { environment } : {},
			...Object.keys(environment).length > 0 ? { environmentValueSources: Object.fromEntries(Object.keys(environment).map((key) => [key, "inline"])) } : {},
			sourcePath: scriptPath
		};
	} catch {
		return null;
	}
}
function hasListenerPid(listener) {
	return typeof listener.pid === "number";
}
function parseSchtasksQuery(output) {
	const entries = parseKeyValueOutput(output, ":");
	const info = {};
	const status = entries.status;
	if (status) info.status = status;
	const lastRunTime = entries["last run time"];
	if (lastRunTime) info.lastRunTime = lastRunTime;
	const lastRunResult = entries["last run result"] ?? entries["last result"];
	if (lastRunResult) info.lastRunResult = lastRunResult;
	return info;
}
function normalizeTaskResultCode(value) {
	if (!value) return null;
	const raw = normalizeLowercaseStringOrEmpty(value);
	if (!raw) return null;
	if (/^0x[0-9a-f]+$/.test(raw)) return `0x${raw.slice(2).replace(/^0+/, "") || "0"}`;
	if (/^\d+$/.test(raw)) {
		const numeric = Number.parseInt(raw, 10);
		if (Number.isFinite(numeric)) return `0x${numeric.toString(16)}`;
	}
	return null;
}
const RUNNING_RESULT_CODES = new Set(["0x41301"]);
const NOT_YET_RUN_RESULT_CODES = new Set(["0x41303"]);
const UNKNOWN_STATUS_DETAIL = "Task status is locale-dependent and no numeric Last Run Result was available.";
const SCHEDULED_TASK_FALLBACK_POLL_MS = 250;
const SCHEDULED_TASK_FALLBACK_TIMEOUT_MS = 15e3;
function deriveScheduledTaskRuntimeStatus(parsed) {
	const normalizedResult = normalizeTaskResultCode(parsed.lastRunResult);
	if (normalizedResult != null) {
		if (RUNNING_RESULT_CODES.has(normalizedResult)) return { status: "running" };
		return {
			status: "stopped",
			detail: `Task Last Run Result=${parsed.lastRunResult}; treating as not running.`
		};
	}
	if (parsed.status?.trim()) return {
		status: "unknown",
		detail: UNKNOWN_STATUS_DETAIL
	};
	return { status: "unknown" };
}
function buildTaskScript({ description, programArguments, workingDirectory, environment }) {
	const lines = ["@echo off"];
	const trimmedDescription = description?.trim();
	if (trimmedDescription) {
		assertNoCmdLineBreak(trimmedDescription, "Task description");
		lines.push(`rem ${trimmedDescription}`);
	}
	if (workingDirectory) lines.push(`cd /d ${quoteCmdScriptArg(workingDirectory)}`);
	if (environment) for (const [key, value] of Object.entries(environment)) {
		if (!value) continue;
		if (key.toUpperCase() === "PATH") continue;
		lines.push(renderCmdSetAssignment(key, value));
	}
	const command = programArguments.map(quoteCmdScriptArg).join(" ");
	lines.push(command);
	return `${lines.join("\r\n")}\r\n`;
}
function renderStartupLaunchCommand(scriptPath) {
	return `start "" /min cmd.exe /d /c ${quoteCmdScriptArg(scriptPath)}`;
}
function buildStartupLauncherScript(params) {
	const lines = ["@echo off"];
	const trimmedDescription = params.description?.trim();
	if (trimmedDescription) {
		assertNoCmdLineBreak(trimmedDescription, "Startup launcher description");
		lines.push(`rem ${trimmedDescription}`);
	}
	lines.push(renderStartupLaunchCommand(params.scriptPath));
	return `${lines.join("\r\n")}\r\n`;
}
function quoteVbsString(value) {
	return `"${value.replace(/"/g, "\"\"")}"`;
}
function quoteVbsRunCommand(scriptPath) {
	return quoteVbsString(`"${scriptPath}"`);
}
function buildHiddenLauncherScript(params) {
	const lines = [];
	const trimmedDescription = params.description?.trim();
	if (trimmedDescription) {
		assertNoCmdLineBreak(trimmedDescription, "Hidden launcher description");
		lines.push(`' ${trimmedDescription}`);
	}
	lines.push(`CreateObject("WScript.Shell").Run ${quoteVbsRunCommand(params.scriptPath)}, 0, False`);
	return `${lines.join("\r\n")}\r\n`;
}
async function assertSchtasksAvailable() {
	const res = await execSchtasks(["/Query"]);
	if (res.code === 0) return;
	const detail = res.stderr || res.stdout;
	throw new Error(`schtasks unavailable: ${detail || "unknown error"}`.trim());
}
async function isStartupEntryInstalled(env) {
	for (const startupEntryPath of resolveStartupEntryPaths(env)) try {
		await fs.access(startupEntryPath);
		return true;
	} catch {}
	return false;
}
async function isRegisteredScheduledTask(env) {
	return (await execSchtasks([
		"/Query",
		"/TN",
		resolveTaskName(env)
	]).catch(() => ({
		code: 1,
		stdout: "",
		stderr: ""
	}))).code === 0;
}
async function launchFallbackTaskScript(env) {
	const scriptPath = resolveTaskScriptPath(env);
	const command = await readScheduledTaskCommand(env);
	if (command?.programArguments.length) {
		const [executable, ...args] = command.programArguments;
		spawn(executable, args, {
			cwd: command.workingDirectory || void 0,
			detached: true,
			env: {
				...process.env,
				...command.environment
			},
			stdio: "ignore",
			windowsHide: true
		}).unref();
		return;
	}
	spawn("cmd.exe", [
		"/d",
		"/c",
		scriptPath
	], {
		detached: true,
		stdio: "ignore",
		windowsHide: true
	}).unref();
}
function resolveConfiguredGatewayPort(env) {
	const raw = env.OPENCLAW_GATEWAY_PORT?.trim();
	if (!raw) return null;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function parsePositivePort(raw) {
	const value = raw?.trim();
	if (!value) return null;
	if (!/^\d+$/.test(value)) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}
function parsePortFromProgramArguments(programArguments) {
	if (!programArguments?.length) return null;
	for (let i = 0; i < programArguments.length; i += 1) {
		const arg = programArguments[i];
		if (!arg) continue;
		const inlineMatch = arg.match(/^--port=(\d+)$/);
		if (inlineMatch) return parsePositivePort(inlineMatch[1]);
		if (arg === "--port") return parsePositivePort(programArguments[i + 1]);
	}
	return null;
}
async function resolveScheduledTaskPort(env) {
	const command = await readScheduledTaskCommand(env).catch(() => null);
	return parsePortFromProgramArguments(command?.programArguments) ?? parsePositivePort(command?.environment?.OPENCLAW_GATEWAY_PORT) ?? resolveConfiguredGatewayPort(env);
}
async function resolveScheduledTaskGatewayListenerPids(port) {
	const verified = findVerifiedGatewayListenerPidsOnPortSync(port);
	if (verified.length > 0) return verified;
	const diagnostics = await inspectPortUsage(port).catch(() => null);
	if (diagnostics?.status !== "busy") return [];
	const matchedGatewayPids = Array.from(new Set(diagnostics.listeners.filter((listener) => typeof listener.pid === "number" && listener.commandLine && isGatewayArgv(parseCmdScriptCommandLine(listener.commandLine), { allowGatewayBinary: true })).map((listener) => listener.pid)));
	if (matchedGatewayPids.length > 0) return matchedGatewayPids;
	return Array.from(new Set(diagnostics.listeners.map((listener) => listener.pid).filter((pid) => typeof pid === "number" && Number.isFinite(pid) && pid > 0)));
}
async function resolveListenerBackedScheduledTaskRuntime(env) {
	const port = await resolveScheduledTaskPort(env);
	if (!port) return null;
	const pids = findVerifiedGatewayListenerPidsOnPortSync(port);
	if (pids.length === 0) return null;
	return {
		status: "running",
		pid: pids[0],
		detail: `Verified gateway listener detected on port ${port} even though schtasks did not report a running task.`
	};
}
async function terminateScheduledTaskGatewayListeners(env) {
	const port = await resolveScheduledTaskPort(env);
	if (!port) return [];
	const pids = await resolveScheduledTaskGatewayListenerPids(port);
	for (const pid of pids) await terminateGatewayProcessTree(pid, 300);
	return pids;
}
function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
async function waitForProcessExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return true;
		await sleep(100);
	}
	return !isProcessAlive(pid);
}
async function terminateGatewayProcessTree(pid, graceMs) {
	if (process.platform !== "win32") {
		killProcessTree(pid, { graceMs });
		return;
	}
	const taskkillPath = path.join(getWindowsInstallRoots().systemRoot, "System32", "taskkill.exe");
	spawnSync(taskkillPath, [
		"/T",
		"/PID",
		String(pid)
	], {
		stdio: "ignore",
		timeout: 5e3,
		windowsHide: true
	});
	if (await waitForProcessExit(pid, graceMs)) return;
	spawnSync(taskkillPath, [
		"/F",
		"/T",
		"/PID",
		String(pid)
	], {
		stdio: "ignore",
		timeout: 5e3,
		windowsHide: true
	});
	await waitForProcessExit(pid, 5e3);
}
async function waitForGatewayPortRelease(port, timeoutMs = 5e3) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await inspectPortUsage(port).catch(() => null))?.status === "free") return true;
		await sleep(250);
	}
	return false;
}
async function terminateBusyPortListeners(port) {
	const diagnostics = await inspectPortUsage(port).catch(() => null);
	if (diagnostics?.status !== "busy") return [];
	const pids = Array.from(new Set(diagnostics.listeners.map((listener) => listener.pid).filter((pid) => typeof pid === "number" && Number.isFinite(pid) && pid > 0)));
	for (const pid of pids) await terminateGatewayProcessTree(pid, 300);
	return pids;
}
async function resolveFallbackRuntime(env) {
	const port = await resolveScheduledTaskPort(env) ?? resolveConfiguredGatewayPort(env);
	if (!port) return {
		status: "unknown",
		detail: "Startup-folder login item installed; gateway port unknown."
	};
	const diagnostics = await inspectPortUsage(port).catch(() => null);
	if (!diagnostics) return {
		status: "unknown",
		detail: `Startup-folder login item installed; could not inspect port ${port}.`
	};
	const listener = diagnostics.listeners.find(hasListenerPid);
	return {
		status: diagnostics.status === "busy" ? "running" : "stopped",
		...listener?.pid ? { pid: listener.pid } : {},
		detail: diagnostics.status === "busy" ? `Startup-folder login item installed; listener detected on port ${port}.` : `Startup-folder login item installed; no listener detected on port ${port}.`
	};
}
async function stopStartupEntry(env, stdout) {
	const runtime = await resolveFallbackRuntime(env);
	if (typeof runtime.pid === "number" && runtime.pid > 0) await terminateGatewayProcessTree(runtime.pid, 300);
	stdout.write(`${formatLine("Stopped Windows login item", resolveTaskName(env))}\n`);
}
async function terminateInstalledStartupRuntime(env) {
	if (!await isStartupEntryInstalled(env)) return;
	const runtime = await resolveFallbackRuntime(env);
	if (typeof runtime.pid === "number" && runtime.pid > 0) await terminateGatewayProcessTree(runtime.pid, 300);
}
async function restartStartupEntry(env, stdout) {
	const runtime = await resolveFallbackRuntime(env);
	if (typeof runtime.pid === "number" && runtime.pid > 0) await terminateGatewayProcessTree(runtime.pid, 300);
	await launchFallbackTaskScript(env);
	stdout.write(`${formatLine("Restarted Windows login item", resolveTaskName(env))}\n`);
	return { outcome: "completed" };
}
async function writeScheduledTaskScript({ env, programArguments, workingDirectory, environment, description }) {
	await assertSchtasksAvailable().catch(() => void 0);
	const scriptPath = resolveTaskScriptPath(env);
	const taskLaunchPath = resolveTaskLauncherScriptPath(env, scriptPath);
	await fs.mkdir(path.dirname(scriptPath), { recursive: true });
	const taskDescription = resolveGatewayServiceDescription({
		env,
		environment,
		description
	});
	const script = buildTaskScript({
		description: taskDescription,
		programArguments,
		workingDirectory,
		environment
	});
	await fs.writeFile(scriptPath, script, "utf8");
	if (taskLaunchPath !== scriptPath) {
		const launcher = buildHiddenLauncherScript({
			description: taskDescription,
			scriptPath
		});
		await fs.writeFile(taskLaunchPath, launcher, "utf8");
	}
	return {
		scriptPath,
		taskLaunchPath,
		taskDescription
	};
}
async function stageScheduledTask({ stdout, ...args }) {
	const { scriptPath } = await writeScheduledTaskScript(args);
	writeFormattedLines(stdout, [{
		label: "Staged task script",
		value: scriptPath
	}], { leadingBlankLine: true });
	return { scriptPath };
}
async function updateExistingScheduledTask(params) {
	if (!await isRegisteredScheduledTask(params.env)) return false;
	if ((await execSchtasks([
		"/Change",
		"/TN",
		params.taskName,
		"/TR",
		params.quotedLaunchPath
	])).code !== 0) return false;
	await runScheduledTaskOrThrow({
		taskName: params.taskName,
		env: params.env,
		scriptPath: params.scriptPath
	});
	writeFormattedLines(params.stdout, [{
		label: "Updated Scheduled Task",
		value: params.taskName
	}, {
		label: "Task script",
		value: params.scriptPath
	}], { leadingBlankLine: true });
	return true;
}
async function shouldFallbackScheduledTaskLaunch(params) {
	const readLaunchObservation = async () => {
		const runtime = await readScheduledTaskRuntime(params.env).catch(() => null);
		if (runtime?.status === "running") return {
			state: "running",
			signature: [
				runtime.state,
				runtime.lastRunTime,
				runtime.lastRunResult,
				runtime.detail
			].filter(Boolean).join("|")
		};
		const normalizedResult = normalizeTaskResultCode(runtime?.lastRunResult);
		if (normalizedResult && NOT_YET_RUN_RESULT_CODES.has(normalizedResult)) return {
			state: "not-yet-run",
			signature: [
				runtime?.state,
				runtime?.lastRunTime,
				runtime?.lastRunResult,
				runtime?.detail
			].filter(Boolean).join("|")
		};
		return {
			state: "other",
			signature: [
				runtime?.state,
				runtime?.lastRunTime,
				runtime?.lastRunResult,
				runtime?.detail
			].filter(Boolean).join("|")
		};
	};
	const hasLaunchEvidence = async () => {
		const port = await resolveScheduledTaskPort(params.env);
		if (port) {
			if ((await resolveScheduledTaskGatewayListenerPids(port)).length > 0) return true;
		}
		if (process.platform !== "win32") return false;
		const scriptPathNeedle = normalizeLowercaseStringOrEmpty(params.scriptPath.replaceAll("/", "\\"));
		if (!scriptPathNeedle) return false;
		const processSnapshot = spawnSync("powershell", [
			"-NoProfile",
			"-Command",
			"Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
		], {
			encoding: "utf8",
			timeout: 1500,
			windowsHide: true
		});
		if (processSnapshot.error || processSnapshot.status !== 0) return false;
		let parsedSnapshot;
		try {
			parsedSnapshot = JSON.parse(processSnapshot.stdout.trim() || "[]");
		} catch {
			return false;
		}
		const entries = (Array.isArray(parsedSnapshot) ? parsedSnapshot : [parsedSnapshot]).filter((entry) => typeof entry === "object" && entry !== null);
		if (entries.some((entry) => normalizeLowercaseStringOrEmpty(entry.CommandLine ?? "").replaceAll("/", "\\").includes(scriptPathNeedle))) return true;
		if (!port) return false;
		return entries.some((entry) => {
			if (!normalizeLowercaseStringOrEmpty(entry.CommandLine ?? "")) return false;
			const argv = parseCmdScriptCommandLine(entry.CommandLine ?? "");
			if (!isGatewayArgv(argv, { allowGatewayBinary: true })) return false;
			return parsePortFromProgramArguments(argv) === port;
		});
	};
	const initial = await readLaunchObservation();
	if (initial.state !== "not-yet-run") return false;
	const deadline = Date.now() + SCHEDULED_TASK_FALLBACK_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await sleep(SCHEDULED_TASK_FALLBACK_POLL_MS);
		const current = await readLaunchObservation();
		if (current.state !== "not-yet-run") return false;
		if (current.signature !== initial.signature) return false;
	}
	return !await hasLaunchEvidence();
}
async function runScheduledTaskOrThrow(params) {
	const run = await execSchtasks([
		"/Run",
		"/TN",
		params.taskName
	]);
	if (run.code !== 0) throw new Error(`schtasks run failed: ${run.stderr || run.stdout}`.trim());
	if (!await shouldFallbackScheduledTaskLaunch({
		env: params.env,
		scriptPath: params.scriptPath
	})) return;
	await launchFallbackTaskScript(params.env);
}
async function activateScheduledTask(params) {
	const taskDescription = params.description ?? "OpenClaw Gateway";
	const taskName = resolveTaskName(params.env);
	const quotedLaunchPath = quoteSchtasksArg(params.taskLaunchPath);
	if (await updateExistingScheduledTask({
		...params,
		taskName,
		quotedLaunchPath
	})) return;
	const baseArgs = [
		"/Create",
		"/F",
		"/SC",
		"ONLOGON",
		"/RL",
		"LIMITED",
		"/TN",
		taskName,
		"/TR",
		quotedLaunchPath
	];
	const taskUser = resolveTaskUser(params.env);
	const taskUserArgs = taskUser ? [
		"/RU",
		taskUser,
		"/NP",
		"/IT"
	] : [];
	let create = await execSchtasks(taskUserArgs.length > 0 ? [...baseArgs, ...taskUserArgs] : baseArgs);
	if (create.code !== 0 && taskUser) create = await execSchtasks(baseArgs);
	if (create.code !== 0) {
		const detail = create.stderr || create.stdout;
		if (shouldFallbackToStartupEntry({
			code: create.code,
			detail
		})) {
			const startupEntryPath = resolveStartupEntryPath(params.env);
			await fs.mkdir(path.dirname(startupEntryPath), { recursive: true });
			const launcher = shouldUseHiddenWindowsTaskLauncher(params.env) ? buildHiddenLauncherScript({
				description: taskDescription,
				scriptPath: params.scriptPath
			}) : buildStartupLauncherScript({
				description: taskDescription,
				scriptPath: params.scriptPath
			});
			await fs.writeFile(startupEntryPath, launcher, "utf8");
			await launchFallbackTaskScript(params.env);
			writeFormattedLines(params.stdout, [{
				label: "Installed Windows login item",
				value: startupEntryPath
			}, {
				label: "Task script",
				value: params.scriptPath
			}], { leadingBlankLine: true });
			return;
		}
		throw new Error(`schtasks create failed: ${detail}`.trim());
	}
	await runScheduledTaskOrThrow({
		taskName,
		env: params.env,
		scriptPath: params.scriptPath
	});
	writeFormattedLines(params.stdout, [{
		label: "Installed Scheduled Task",
		value: taskName
	}, {
		label: "Task script",
		value: params.scriptPath
	}], { leadingBlankLine: true });
}
async function installScheduledTask(args) {
	const staged = await writeScheduledTaskScript(args);
	await activateScheduledTask({
		env: args.env,
		stdout: args.stdout,
		scriptPath: staged.scriptPath,
		taskLaunchPath: staged.taskLaunchPath,
		description: staged.taskDescription
	});
	return { scriptPath: staged.scriptPath };
}
async function uninstallScheduledTask({ env, stdout }) {
	await assertSchtasksAvailable();
	const taskName = resolveTaskName(env);
	if (await isRegisteredScheduledTask(env).catch(() => false)) await execSchtasks([
		"/Delete",
		"/F",
		"/TN",
		taskName
	]);
	for (const startupEntryPath of resolveStartupEntryPaths(env)) try {
		await fs.unlink(startupEntryPath);
		stdout.write(`${formatLine("Removed Windows login item", startupEntryPath)}\n`);
	} catch {}
	const scriptPath = resolveTaskScriptPath(env);
	const launcherPath = resolveTaskLauncherScriptPath(env, scriptPath);
	if (launcherPath !== scriptPath) try {
		await fs.unlink(launcherPath);
		stdout.write(`${formatLine("Removed task launcher", launcherPath)}\n`);
	} catch {}
	try {
		await fs.unlink(scriptPath);
		stdout.write(`${formatLine("Removed task script", scriptPath)}\n`);
	} catch {
		stdout.write(`Task script not found at ${scriptPath}\n`);
	}
}
function isTaskNotRunning(res) {
	return normalizeLowercaseStringOrEmpty(res.stderr || res.stdout).includes("not running");
}
async function stopScheduledTask({ stdout, env }) {
	const effectiveEnv = env ?? process.env;
	try {
		await assertSchtasksAvailable();
	} catch (err) {
		if (await isStartupEntryInstalled(effectiveEnv)) {
			await stopStartupEntry(effectiveEnv, stdout);
			return;
		}
		throw err;
	}
	if (!await isRegisteredScheduledTask(effectiveEnv)) {
		if (await isStartupEntryInstalled(effectiveEnv)) {
			await stopStartupEntry(effectiveEnv, stdout);
			return;
		}
	}
	const taskName = resolveTaskName(effectiveEnv);
	const res = await execSchtasks([
		"/End",
		"/TN",
		taskName
	]);
	if (res.code !== 0 && !isTaskNotRunning(res)) throw new Error(`schtasks end failed: ${res.stderr || res.stdout}`.trim());
	const stopPort = await resolveScheduledTaskPort(effectiveEnv);
	await terminateScheduledTaskGatewayListeners(effectiveEnv);
	await terminateInstalledStartupRuntime(effectiveEnv);
	if (stopPort) {
		if (!await waitForGatewayPortRelease(stopPort)) {
			await terminateBusyPortListeners(stopPort);
			if (!await waitForGatewayPortRelease(stopPort, 2e3)) throw new Error(`gateway port ${stopPort} is still busy after stop`);
		}
	}
	stdout.write(`${formatLine("Stopped Scheduled Task", taskName)}\n`);
}
async function restartScheduledTask({ stdout, env }) {
	const effectiveEnv = env ?? process.env;
	try {
		await assertSchtasksAvailable();
	} catch (err) {
		if (await isStartupEntryInstalled(effectiveEnv)) return await restartStartupEntry(effectiveEnv, stdout);
		throw err;
	}
	if (!await isRegisteredScheduledTask(effectiveEnv)) {
		if (await isStartupEntryInstalled(effectiveEnv)) return await restartStartupEntry(effectiveEnv, stdout);
	}
	const taskName = resolveTaskName(effectiveEnv);
	await execSchtasks([
		"/End",
		"/TN",
		taskName
	]);
	const restartPort = await resolveScheduledTaskPort(effectiveEnv);
	await terminateScheduledTaskGatewayListeners(effectiveEnv);
	await terminateInstalledStartupRuntime(effectiveEnv);
	if (restartPort) {
		if (!await waitForGatewayPortRelease(restartPort)) {
			await terminateBusyPortListeners(restartPort);
			if (!await waitForGatewayPortRelease(restartPort, 2e3)) throw new Error(`gateway port ${restartPort} is still busy before restart`);
		}
	}
	await runScheduledTaskOrThrow({
		taskName,
		env: effectiveEnv,
		scriptPath: resolveTaskScriptPath(effectiveEnv)
	});
	stdout.write(`${formatLine("Restarted Scheduled Task", taskName)}\n`);
	return { outcome: "completed" };
}
async function isScheduledTaskInstalled(args) {
	const effectiveEnv = args.env ?? process.env;
	if (await isRegisteredScheduledTask(effectiveEnv)) return true;
	return await isStartupEntryInstalled(effectiveEnv);
}
async function readScheduledTaskRuntime(env = process.env) {
	try {
		await assertSchtasksAvailable();
	} catch (err) {
		if (await isStartupEntryInstalled(env)) return await resolveFallbackRuntime(env);
		return {
			status: "unknown",
			detail: String(err)
		};
	}
	const res = await execSchtasks([
		"/Query",
		"/TN",
		resolveTaskName(env),
		"/V",
		"/FO",
		"LIST"
	]);
	if (res.code !== 0) {
		if (await isStartupEntryInstalled(env)) return await resolveFallbackRuntime(env);
		const detail = (res.stderr || res.stdout).trim();
		const missing = normalizeLowercaseStringOrEmpty(detail).includes("cannot find the file");
		return {
			status: missing ? "stopped" : "unknown",
			detail: detail || void 0,
			missingUnit: missing
		};
	}
	const parsed = parseSchtasksQuery(res.stdout || "");
	const derived = deriveScheduledTaskRuntimeStatus(parsed);
	if (derived.status !== "running") {
		const observedRuntime = await resolveListenerBackedScheduledTaskRuntime(env);
		if (observedRuntime) return {
			...observedRuntime,
			state: parsed.status,
			lastRunTime: parsed.lastRunTime,
			lastRunResult: parsed.lastRunResult
		};
	}
	return {
		status: derived.status,
		state: parsed.status,
		lastRunTime: parsed.lastRunTime,
		lastRunResult: parsed.lastRunResult,
		...derived.detail ? { detail: derived.detail } : {}
	};
}
//#endregion
export { resolveTaskScriptPath as a, stopScheduledTask as c, readScheduledTaskRuntime as i, uninstallScheduledTask as l, isScheduledTaskInstalled as n, restartScheduledTask as o, readScheduledTaskCommand as r, stageScheduledTask as s, installScheduledTask as t };
