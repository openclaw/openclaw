import { d as init_utils, w as sleep } from "./utils-BiUV1eIQ.js";
import { t as runCommandWithTimeout } from "./exec-BmPfiSbq.js";
import { a as inspectPortUsage } from "./ports-D4BnBb9r.js";
import { d as resolveGatewayServiceDescription, p as resolveGatewayWindowsTaskName } from "./constants-C8ub4F0Y.js";
import { a as renderCmdSetAssignment, i as parseCmdSetAssignment, n as quoteCmdScriptArg, o as killProcessTree, r as assertNoCmdLineBreak, t as parseCmdScriptCommandLine } from "./cmd-argv-DFVIyCDr.js";
import { n as findGatewayPidsOnPortSync } from "./restart-stale-pids-Be6QOzfZ.js";
import { i as formatLine, n as resolveGatewayStateDir, o as writeFormattedLines, t as parseKeyValueOutput } from "./runtime-parse-DJmitJVt.js";
import { a as readLaunchAgentProgramArguments, d as stopLaunchAgent, f as uninstallLaunchAgent, o as readLaunchAgentRuntime, r as isLaunchAgentLoaded, t as installLaunchAgent, u as restartLaunchAgent } from "./launchd-CYc1PBHk.js";
import { a as readSystemdServiceExecStart, c as restartSystemdService, d as uninstallSystemdService, l as stopSystemdService, o as readSystemdServiceRuntime, r as isSystemdServiceEnabled, t as installSystemdService } from "./systemd-Ca2xqSN-.js";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import fs$1 from "node:fs/promises";
//#region src/infra/gateway-process-argv.ts
function normalizeProcArg(arg) {
	return arg.replaceAll("\\", "/").toLowerCase();
}
function parseProcCmdline(raw) {
	return raw.split("\0").map((entry) => entry.trim()).filter(Boolean);
}
function isGatewayArgv(args, opts) {
	const normalized = args.map(normalizeProcArg);
	if (!normalized.includes("gateway")) return false;
	const entryCandidates = [
		"dist/index.js",
		"dist/entry.js",
		"openclaw.mjs",
		"scripts/run-node.mjs",
		"src/entry.ts",
		"src/index.ts"
	];
	if (normalized.some((arg) => entryCandidates.some((entry) => arg.endsWith(entry)))) return true;
	const exe = (normalized[0] ?? "").replace(/\.(bat|cmd|exe)$/i, "");
	return exe.endsWith("/openclaw") || exe === "openclaw" || opts?.allowGatewayBinary === true && exe.endsWith("/openclaw-gateway");
}
//#endregion
//#region src/infra/gateway-processes.ts
const WINDOWS_GATEWAY_DISCOVERY_TIMEOUT_MS = 5e3;
function extractWindowsCommandLine(raw) {
	const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (const line of lines) {
		if (!line.toLowerCase().startsWith("commandline=")) continue;
		return line.slice(12).trim() || null;
	}
	return lines.find((line) => line.toLowerCase() !== "commandline") ?? null;
}
function readWindowsProcessArgsViaPowerShell(pid) {
	const ps = spawnSync("powershell", [
		"-NoProfile",
		"-Command",
		`(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine)`
	], {
		encoding: "utf8",
		timeout: WINDOWS_GATEWAY_DISCOVERY_TIMEOUT_MS,
		windowsHide: true
	});
	if (ps.error || ps.status !== 0) return null;
	const command = ps.stdout.trim();
	return command ? parseCmdScriptCommandLine(command) : null;
}
function readWindowsProcessArgsViaWmic(pid) {
	const wmic = spawnSync("wmic", [
		"process",
		"where",
		`ProcessId=${pid}`,
		"get",
		"CommandLine",
		"/value"
	], {
		encoding: "utf8",
		timeout: WINDOWS_GATEWAY_DISCOVERY_TIMEOUT_MS,
		windowsHide: true
	});
	if (wmic.error || wmic.status !== 0) return null;
	const command = extractWindowsCommandLine(wmic.stdout);
	return command ? parseCmdScriptCommandLine(command) : null;
}
function readWindowsListeningPidsViaPowerShell(port) {
	const ps = spawnSync("powershell", [
		"-NoProfile",
		"-Command",
		`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)`
	], {
		encoding: "utf8",
		timeout: WINDOWS_GATEWAY_DISCOVERY_TIMEOUT_MS,
		windowsHide: true
	});
	if (ps.error || ps.status !== 0) return null;
	return ps.stdout.split(/\r?\n/).map((line) => Number.parseInt(line.trim(), 10)).filter((pid) => Number.isFinite(pid) && pid > 0);
}
function readWindowsListeningPidsViaNetstat(port) {
	const netstat = spawnSync("netstat", [
		"-ano",
		"-p",
		"tcp"
	], {
		encoding: "utf8",
		timeout: WINDOWS_GATEWAY_DISCOVERY_TIMEOUT_MS,
		windowsHide: true
	});
	if (netstat.error || netstat.status !== 0) return [];
	const pids = /* @__PURE__ */ new Set();
	for (const line of netstat.stdout.split(/\r?\n/)) {
		const match = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
		if (!match) continue;
		const parsedPort = Number.parseInt(match[2] ?? "", 10);
		const pid = Number.parseInt(match[3] ?? "", 10);
		if (parsedPort === port && Number.isFinite(pid) && pid > 0) pids.add(pid);
	}
	return [...pids];
}
function readWindowsListeningPidsOnPortSync(port) {
	return readWindowsListeningPidsViaPowerShell(port) ?? readWindowsListeningPidsViaNetstat(port);
}
function readGatewayProcessArgsSync(pid) {
	if (process.platform === "linux") try {
		return parseProcCmdline(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
	} catch {
		return null;
	}
	if (process.platform === "darwin") {
		const ps = spawnSync("ps", [
			"-o",
			"command=",
			"-p",
			String(pid)
		], {
			encoding: "utf8",
			timeout: 1e3
		});
		if (ps.error || ps.status !== 0) return null;
		const command = ps.stdout.trim();
		return command ? command.split(/\s+/) : null;
	}
	if (process.platform === "win32") return readWindowsProcessArgsViaPowerShell(pid) ?? readWindowsProcessArgsViaWmic(pid);
	return null;
}
function signalVerifiedGatewayPidSync(pid, signal) {
	const args = readGatewayProcessArgsSync(pid);
	if (!args || !isGatewayArgv(args, { allowGatewayBinary: true })) throw new Error(`refusing to signal non-gateway process pid ${pid}`);
	process.kill(pid, signal);
}
function findVerifiedGatewayListenerPidsOnPortSync(port) {
	const rawPids = process.platform === "win32" ? readWindowsListeningPidsOnPortSync(port) : findGatewayPidsOnPortSync(port);
	return Array.from(new Set(rawPids)).filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid).filter((pid) => {
		const args = readGatewayProcessArgsSync(pid);
		return args != null && isGatewayArgv(args, { allowGatewayBinary: true });
	});
}
function formatGatewayPidList(pids) {
	return pids.join(", ");
}
//#endregion
//#region src/daemon/schtasks-exec.ts
const SCHTASKS_TIMEOUT_MS = 15e3;
const SCHTASKS_NO_OUTPUT_TIMEOUT_MS = 5e3;
async function execSchtasks(args) {
	const result = await runCommandWithTimeout(["schtasks", ...args], {
		timeoutMs: SCHTASKS_TIMEOUT_MS,
		noOutputTimeoutMs: SCHTASKS_NO_OUTPUT_TIMEOUT_MS
	});
	const timeoutDetail = result.termination === "timeout" ? `schtasks timed out after ${SCHTASKS_TIMEOUT_MS}ms` : result.termination === "no-output-timeout" ? `schtasks produced no output for ${SCHTASKS_NO_OUTPUT_TIMEOUT_MS}ms` : "";
	return {
		stdout: result.stdout,
		stderr: result.stderr || timeoutDetail,
		code: typeof result.code === "number" ? result.code : result.killed ? 124 : 1
	};
}
//#endregion
//#region src/daemon/schtasks.ts
init_utils();
function resolveTaskName(env) {
	const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
	if (override) return override;
	return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}
function shouldFallbackToStartupEntry(params) {
	return /access is denied/i.test(params.detail) || params.code === 124 || /schtasks timed out/i.test(params.detail) || /schtasks produced no output/i.test(params.detail);
}
function resolveTaskScriptPath(env) {
	const override = env.OPENCLAW_TASK_SCRIPT?.trim();
	if (override) return override;
	const scriptName = env.OPENCLAW_TASK_SCRIPT_NAME?.trim() || "gateway.cmd";
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
function resolveStartupEntryPath(env) {
	const taskName = resolveTaskName(env);
	return path.join(resolveWindowsStartupDir(env), `${sanitizeWindowsFilename(taskName)}.cmd`);
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
async function readScheduledTaskCommand(env) {
	const scriptPath = resolveTaskScriptPath(env);
	try {
		const content = await fs$1.readFile(scriptPath, "utf8");
		let workingDirectory = "";
		let commandLine = "";
		const environment = {};
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line) continue;
			const lower = line.toLowerCase();
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
	const raw = value.trim().toLowerCase();
	if (!raw) return null;
	if (/^0x[0-9a-f]+$/.test(raw)) return `0x${raw.slice(2).replace(/^0+/, "") || "0"}`;
	if (/^\d+$/.test(raw)) {
		const numeric = Number.parseInt(raw, 10);
		if (Number.isFinite(numeric)) return `0x${numeric.toString(16)}`;
	}
	return null;
}
const RUNNING_RESULT_CODES = new Set(["0x41301"]);
const UNKNOWN_STATUS_DETAIL = "Task status is locale-dependent and no numeric Last Run Result was available.";
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
function buildStartupLauncherScript(params) {
	const lines = ["@echo off"];
	const trimmedDescription = params.description?.trim();
	if (trimmedDescription) {
		assertNoCmdLineBreak(trimmedDescription, "Startup launcher description");
		lines.push(`rem ${trimmedDescription}`);
	}
	lines.push(`start "" /min cmd.exe /d /c ${quoteCmdScriptArg(params.scriptPath)}`);
	return `${lines.join("\r\n")}\r\n`;
}
async function assertSchtasksAvailable() {
	const res = await execSchtasks(["/Query"]);
	if (res.code === 0) return;
	const detail = res.stderr || res.stdout;
	throw new Error(`schtasks unavailable: ${detail || "unknown error"}`.trim());
}
async function isStartupEntryInstalled(env) {
	try {
		await fs$1.access(resolveStartupEntryPath(env));
		return true;
	} catch {
		return false;
	}
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
function launchFallbackTaskScript(scriptPath) {
	spawn("cmd.exe", [
		"/d",
		"/s",
		"/c",
		quoteCmdScriptArg(scriptPath)
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
	const taskkillPath = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
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
	launchFallbackTaskScript(resolveTaskScriptPath(env));
	stdout.write(`${formatLine("Restarted Windows login item", resolveTaskName(env))}\n`);
	return { outcome: "completed" };
}
async function installScheduledTask({ env, stdout, programArguments, workingDirectory, environment, description }) {
	await assertSchtasksAvailable();
	const scriptPath = resolveTaskScriptPath(env);
	await fs$1.mkdir(path.dirname(scriptPath), { recursive: true });
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
	await fs$1.writeFile(scriptPath, script, "utf8");
	const taskName = resolveTaskName(env);
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
		quoteSchtasksArg(scriptPath)
	];
	const taskUser = resolveTaskUser(env);
	let create = await execSchtasks(taskUser ? [
		...baseArgs,
		"/RU",
		taskUser,
		"/NP",
		"/IT"
	] : baseArgs);
	if (create.code !== 0 && taskUser) create = await execSchtasks(baseArgs);
	if (create.code !== 0) {
		const detail = create.stderr || create.stdout;
		if (shouldFallbackToStartupEntry({
			code: create.code,
			detail
		})) {
			const startupEntryPath = resolveStartupEntryPath(env);
			await fs$1.mkdir(path.dirname(startupEntryPath), { recursive: true });
			const launcher = buildStartupLauncherScript({
				description: taskDescription,
				scriptPath
			});
			await fs$1.writeFile(startupEntryPath, launcher, "utf8");
			launchFallbackTaskScript(scriptPath);
			writeFormattedLines(stdout, [{
				label: "Installed Windows login item",
				value: startupEntryPath
			}, {
				label: "Task script",
				value: scriptPath
			}], { leadingBlankLine: true });
			return { scriptPath };
		}
		throw new Error(`schtasks create failed: ${detail}`.trim());
	}
	await execSchtasks([
		"/Run",
		"/TN",
		taskName
	]);
	writeFormattedLines(stdout, [{
		label: "Installed Scheduled Task",
		value: taskName
	}, {
		label: "Task script",
		value: scriptPath
	}], { leadingBlankLine: true });
	return { scriptPath };
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
	const startupEntryPath = resolveStartupEntryPath(env);
	try {
		await fs$1.unlink(startupEntryPath);
		stdout.write(`${formatLine("Removed Windows login item", startupEntryPath)}\n`);
	} catch {}
	const scriptPath = resolveTaskScriptPath(env);
	try {
		await fs$1.unlink(scriptPath);
		stdout.write(`${formatLine("Removed task script", scriptPath)}\n`);
	} catch {
		stdout.write(`Task script not found at ${scriptPath}\n`);
	}
}
function isTaskNotRunning(res) {
	return (res.stderr || res.stdout).toLowerCase().includes("not running");
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
	const res = await execSchtasks([
		"/Run",
		"/TN",
		taskName
	]);
	if (res.code !== 0) throw new Error(`schtasks run failed: ${res.stderr || res.stdout}`.trim());
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
		const missing = detail.toLowerCase().includes("cannot find the file");
		return {
			status: missing ? "stopped" : "unknown",
			detail: detail || void 0,
			missingUnit: missing
		};
	}
	const parsed = parseSchtasksQuery(res.stdout || "");
	const derived = deriveScheduledTaskRuntimeStatus(parsed);
	return {
		status: derived.status,
		state: parsed.status,
		lastRunTime: parsed.lastRunTime,
		lastRunResult: parsed.lastRunResult,
		...derived.detail ? { detail: derived.detail } : {}
	};
}
//#endregion
//#region src/daemon/service.ts
function ignoreInstallResult(install) {
	return async (args) => {
		await install(args);
	};
}
function describeGatewayServiceRestart(serviceNoun, result) {
	if (result.outcome === "scheduled") return {
		scheduled: true,
		daemonActionResult: "scheduled",
		message: `restart scheduled, ${serviceNoun.toLowerCase()} will restart momentarily`,
		progressMessage: `${serviceNoun} service restart scheduled.`
	};
	return {
		scheduled: false,
		daemonActionResult: "restarted",
		message: `${serviceNoun} service restarted.`,
		progressMessage: `${serviceNoun} service restarted.`
	};
}
const GATEWAY_SERVICE_REGISTRY = {
	darwin: {
		label: "LaunchAgent",
		loadedText: "loaded",
		notLoadedText: "not loaded",
		install: ignoreInstallResult(installLaunchAgent),
		uninstall: uninstallLaunchAgent,
		stop: stopLaunchAgent,
		restart: restartLaunchAgent,
		isLoaded: isLaunchAgentLoaded,
		readCommand: readLaunchAgentProgramArguments,
		readRuntime: readLaunchAgentRuntime
	},
	linux: {
		label: "systemd",
		loadedText: "enabled",
		notLoadedText: "disabled",
		install: ignoreInstallResult(installSystemdService),
		uninstall: uninstallSystemdService,
		stop: stopSystemdService,
		restart: restartSystemdService,
		isLoaded: isSystemdServiceEnabled,
		readCommand: readSystemdServiceExecStart,
		readRuntime: readSystemdServiceRuntime
	},
	win32: {
		label: "Scheduled Task",
		loadedText: "registered",
		notLoadedText: "missing",
		install: ignoreInstallResult(installScheduledTask),
		uninstall: uninstallScheduledTask,
		stop: stopScheduledTask,
		restart: restartScheduledTask,
		isLoaded: isScheduledTaskInstalled,
		readCommand: readScheduledTaskCommand,
		readRuntime: readScheduledTaskRuntime
	}
};
function isSupportedGatewayServicePlatform(platform) {
	return Object.hasOwn(GATEWAY_SERVICE_REGISTRY, platform);
}
function resolveGatewayService() {
	if (isSupportedGatewayServicePlatform(process.platform)) return GATEWAY_SERVICE_REGISTRY[process.platform];
	throw new Error(`Gateway service install not supported on ${process.platform}`);
}
//#endregion
export { formatGatewayPidList as a, parseProcCmdline as c, findVerifiedGatewayListenerPidsOnPortSync as i, resolveGatewayService as n, signalVerifiedGatewayPidSync as o, execSchtasks as r, isGatewayArgv as s, describeGatewayServiceRestart as t };
