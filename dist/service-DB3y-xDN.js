import { Co as parseCmdScriptCommandLine, Do as renderCmdSetAssignment, Eo as parseCmdSetAssignment, To as assertNoCmdLineBreak, Zs as killProcessTree, wm as inspectPortUsage, wo as quoteCmdScriptArg } from "./auth-profiles-CAw5gP6f.js";
import { t as runCommandWithTimeout } from "./exec-CHkvLtoM.js";
import { C as parseStrictInteger, T as parseStrictPositiveInteger, _ as resolveGatewayWindowsTaskName, a as GATEWAY_LAUNCH_AGENT_LABEL, h as resolveGatewayServiceDescription, p as resolveGatewayLaunchAgentLabel, v as resolveLegacyGatewayLaunchAgentLabels } from "./prompt-style-2BF77KhS.js";
import { _ as formatLine, a as readSystemdServiceExecStart, b as execFileUtf8, c as restartSystemdService, d as uninstallSystemdService, g as resolveHomeDir, h as resolveGatewayStateDir, l as stopSystemdService, m as parseKeyValueOutput, o as readSystemdServiceRuntime, r as isSystemdServiceEnabled, t as installSystemdService, v as toPosixPath, y as writeFormattedLines } from "./systemd-DuQVc30D.js";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
const plistEscape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;");
const plistUnescape = (value) => value.replaceAll("&apos;", "'").replaceAll("&quot;", "\"").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
const renderEnvDict = (env) => {
	if (!env) return "";
	const entries = Object.entries(env).filter(([, value]) => typeof value === "string" && value.trim());
	if (entries.length === 0) return "";
	return `\n    <key>EnvironmentVariables</key>\n    <dict>${entries.map(([key, value]) => `\n    <key>${plistEscape(key)}</key>\n    <string>${plistEscape(value?.trim() ?? "")}</string>`).join("")}\n    </dict>`;
};
async function readLaunchAgentProgramArgumentsFromFile(plistPath) {
	try {
		const plist = await fs.readFile(plistPath, "utf8");
		const programMatch = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/i);
		if (!programMatch) return null;
		const args = Array.from(programMatch[1].matchAll(/<string>([\s\S]*?)<\/string>/gi)).map((match) => plistUnescape(match[1] ?? "").trim());
		const workingDirMatch = plist.match(/<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/i);
		const workingDirectory = workingDirMatch ? plistUnescape(workingDirMatch[1] ?? "").trim() : "";
		const envMatch = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/i);
		const environment = {};
		if (envMatch) for (const pair of envMatch[1].matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/gi)) {
			const key = plistUnescape(pair[1] ?? "").trim();
			if (!key) continue;
			environment[key] = plistUnescape(pair[2] ?? "").trim();
		}
		return {
			programArguments: args.filter(Boolean),
			...workingDirectory ? { workingDirectory } : {},
			...Object.keys(environment).length > 0 ? { environment } : {},
			sourcePath: plistPath
		};
	} catch {
		return null;
	}
}
function buildLaunchAgentPlist$1({ label, comment, programArguments, workingDirectory, stdoutPath, stderrPath, environment }) {
	const argsXml = programArguments.map((arg) => `\n      <string>${plistEscape(arg)}</string>`).join("");
	const workingDirXml = workingDirectory ? `\n    <key>WorkingDirectory</key>\n    <string>${plistEscape(workingDirectory)}</string>` : "";
	const commentXml = comment?.trim() ? `\n    <key>Comment</key>\n    <string>${plistEscape(comment.trim())}</string>` : "";
	const envXml = renderEnvDict(environment);
	return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n    <key>Label</key>\n    <string>${plistEscape(label)}</string>\n    ${commentXml}\n    <key>RunAtLoad</key>\n    <true/>\n    <key>KeepAlive</key>\n    <true/>\n    <key>ThrottleInterval</key>\n    <integer>1</integer>\n    <key>Umask</key>\n    <integer>63</integer>\n    <key>ProgramArguments</key>\n    <array>${argsXml}\n    </array>\n    ${workingDirXml}\n    <key>StandardOutPath</key>\n    <string>${plistEscape(stdoutPath)}</string>\n    <key>StandardErrorPath</key>\n    <string>${plistEscape(stderrPath)}</string>${envXml}\n  </dict>\n</plist>\n`;
}
//#endregion
//#region src/daemon/launchd-restart-handoff.ts
function resolveGuiDomain$1() {
	if (typeof process.getuid !== "function") return "gui/501";
	return `gui/${process.getuid()}`;
}
function resolveLaunchAgentLabel$1(env) {
	const envLabel = env?.OPENCLAW_LAUNCHD_LABEL?.trim();
	if (envLabel) return envLabel;
	return resolveGatewayLaunchAgentLabel(env?.OPENCLAW_PROFILE);
}
function resolveLaunchdRestartTarget(env = process.env) {
	const domain = resolveGuiDomain$1();
	const label = resolveLaunchAgentLabel$1(env);
	const home = env.HOME?.trim() || os.homedir();
	return {
		domain,
		label,
		plistPath: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
		serviceTarget: `${domain}/${label}`
	};
}
function isCurrentProcessLaunchdServiceLabel(label, env = process.env) {
	const launchdLabel = env.LAUNCH_JOB_LABEL?.trim() || env.LAUNCH_JOB_NAME?.trim() || env.XPC_SERVICE_NAME?.trim();
	if (launchdLabel) return launchdLabel === label;
	const configuredLabel = env.OPENCLAW_LAUNCHD_LABEL?.trim();
	return Boolean(configuredLabel && configuredLabel === label);
}
function buildLaunchdRestartScript(mode) {
	const waitForCallerPid = `wait_pid="$4"
if [ -n "$wait_pid" ] && [ "$wait_pid" -gt 1 ] 2>/dev/null; then
  while kill -0 "$wait_pid" >/dev/null 2>&1; do
    sleep 0.1
  done
fi
`;
	if (mode === "kickstart") return `service_target="$1"
domain="$2"
plist_path="$3"
${waitForCallerPid}
if ! launchctl kickstart -k "$service_target" >/dev/null 2>&1; then
  launchctl enable "$service_target" >/dev/null 2>&1
  if launchctl bootstrap "$domain" "$plist_path" >/dev/null 2>&1; then
    launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
  fi
fi
`;
	return `service_target="$1"
domain="$2"
plist_path="$3"
${waitForCallerPid}
if ! launchctl start "$service_target" >/dev/null 2>&1; then
  launchctl enable "$service_target" >/dev/null 2>&1
  if launchctl bootstrap "$domain" "$plist_path" >/dev/null 2>&1; then
    launchctl start "$service_target" >/dev/null 2>&1 || launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
  else
    launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
  fi
fi
`;
}
function scheduleDetachedLaunchdRestartHandoff(params) {
	const target = resolveLaunchdRestartTarget(params.env);
	const waitForPid = typeof params.waitForPid === "number" && Number.isFinite(params.waitForPid) ? Math.floor(params.waitForPid) : 0;
	try {
		const child = spawn("/bin/sh", [
			"-c",
			buildLaunchdRestartScript(params.mode),
			"openclaw-launchd-restart-handoff",
			target.serviceTarget,
			target.domain,
			target.plistPath,
			String(waitForPid)
		], {
			detached: true,
			stdio: "ignore",
			env: {
				...process.env,
				...params.env
			}
		});
		child.unref();
		return {
			ok: true,
			pid: child.pid ?? void 0
		};
	} catch (err) {
		return {
			ok: false,
			detail: err instanceof Error ? err.message : String(err)
		};
	}
}
//#endregion
//#region src/daemon/launchd.ts
const LAUNCH_AGENT_DIR_MODE = 493;
const LAUNCH_AGENT_PLIST_MODE = 420;
function resolveLaunchAgentLabel(args) {
	const envLabel = args?.env?.OPENCLAW_LAUNCHD_LABEL?.trim();
	if (envLabel) return envLabel;
	return resolveGatewayLaunchAgentLabel(args?.env?.OPENCLAW_PROFILE);
}
function resolveLaunchAgentPlistPathForLabel(env, label) {
	const home = toPosixPath(resolveHomeDir(env));
	return path.posix.join(home, "Library", "LaunchAgents", `${label}.plist`);
}
function resolveLaunchAgentPlistPath(env) {
	return resolveLaunchAgentPlistPathForLabel(env, resolveLaunchAgentLabel({ env }));
}
function resolveGatewayLogPaths(env) {
	const stateDir = resolveGatewayStateDir(env);
	const logDir = path.join(stateDir, "logs");
	const prefix = env.OPENCLAW_LOG_PREFIX?.trim() || "gateway";
	return {
		logDir,
		stdoutPath: path.join(logDir, `${prefix}.log`),
		stderrPath: path.join(logDir, `${prefix}.err.log`)
	};
}
async function readLaunchAgentProgramArguments(env) {
	return readLaunchAgentProgramArgumentsFromFile(resolveLaunchAgentPlistPath(env));
}
function buildLaunchAgentPlist({ label = GATEWAY_LAUNCH_AGENT_LABEL, comment, programArguments, workingDirectory, stdoutPath, stderrPath, environment }) {
	return buildLaunchAgentPlist$1({
		label,
		comment,
		programArguments,
		workingDirectory,
		stdoutPath,
		stderrPath,
		environment
	});
}
async function execLaunchctl(args) {
	const isWindows = process.platform === "win32";
	return await execFileUtf8(isWindows ? process.env.ComSpec ?? "cmd.exe" : "launchctl", isWindows ? [
		"/d",
		"/s",
		"/c",
		"launchctl",
		...args
	] : args, isWindows ? { windowsHide: true } : {});
}
function resolveGuiDomain() {
	if (typeof process.getuid !== "function") return "gui/501";
	return `gui/${process.getuid()}`;
}
async function ensureSecureDirectory(targetPath) {
	await fs.mkdir(targetPath, {
		recursive: true,
		mode: LAUNCH_AGENT_DIR_MODE
	});
	try {
		const mode = (await fs.stat(targetPath)).mode & 511;
		const tightenedMode = mode & -19;
		if (tightenedMode !== mode) await fs.chmod(targetPath, tightenedMode);
	} catch {}
}
function parseLaunchctlPrint(output) {
	const entries = parseKeyValueOutput(output, "=");
	const info = {};
	const state = entries.state;
	if (state) info.state = state;
	const pidValue = entries.pid;
	if (pidValue) {
		const pid = parseStrictPositiveInteger(pidValue);
		if (pid !== void 0) info.pid = pid;
	}
	const exitStatusValue = entries["last exit status"];
	if (exitStatusValue) {
		const status = parseStrictInteger(exitStatusValue);
		if (status !== void 0) info.lastExitStatus = status;
	}
	const exitReason = entries["last exit reason"];
	if (exitReason) info.lastExitReason = exitReason;
	return info;
}
async function isLaunchAgentLoaded(args) {
	return (await execLaunchctl(["print", `${resolveGuiDomain()}/${resolveLaunchAgentLabel({ env: args.env })}`])).code === 0;
}
async function isLaunchAgentListed(args) {
	const label = resolveLaunchAgentLabel({ env: args.env });
	const res = await execLaunchctl(["list"]);
	if (res.code !== 0) return false;
	return res.stdout.split(/\r?\n/).some((line) => line.trim().split(/\s+/).at(-1) === label);
}
async function launchAgentPlistExists(env) {
	try {
		const plistPath = resolveLaunchAgentPlistPath(env);
		await fs.access(plistPath);
		return true;
	} catch {
		return false;
	}
}
async function readLaunchAgentRuntime(env) {
	const res = await execLaunchctl(["print", `${resolveGuiDomain()}/${resolveLaunchAgentLabel({ env })}`]);
	if (res.code !== 0) return {
		status: "unknown",
		detail: (res.stderr || res.stdout).trim() || void 0,
		missingUnit: true
	};
	const parsed = parseLaunchctlPrint(res.stdout || res.stderr || "");
	const plistExists = await launchAgentPlistExists(env);
	const state = parsed.state?.toLowerCase();
	return {
		status: state === "running" || parsed.pid ? "running" : state ? "stopped" : "unknown",
		state: parsed.state,
		pid: parsed.pid,
		lastExitStatus: parsed.lastExitStatus,
		lastExitReason: parsed.lastExitReason,
		cachedLabel: !plistExists
	};
}
async function repairLaunchAgentBootstrap(args) {
	const env = args.env ?? process.env;
	const domain = resolveGuiDomain();
	const label = resolveLaunchAgentLabel({ env });
	const plistPath = resolveLaunchAgentPlistPath(env);
	await execLaunchctl(["enable", `${domain}/${label}`]);
	const boot = await execLaunchctl([
		"bootstrap",
		domain,
		plistPath
	]);
	if (boot.code !== 0) return {
		ok: false,
		detail: (boot.stderr || boot.stdout).trim() || void 0
	};
	const kick = await execLaunchctl([
		"kickstart",
		"-k",
		`${domain}/${label}`
	]);
	if (kick.code !== 0) return {
		ok: false,
		detail: (kick.stderr || kick.stdout).trim() || void 0
	};
	return { ok: true };
}
async function uninstallLaunchAgent({ env, stdout }) {
	const domain = resolveGuiDomain();
	const label = resolveLaunchAgentLabel({ env });
	const plistPath = resolveLaunchAgentPlistPath(env);
	await execLaunchctl([
		"bootout",
		domain,
		plistPath
	]);
	await execLaunchctl(["unload", plistPath]);
	try {
		await fs.access(plistPath);
	} catch {
		stdout.write(`LaunchAgent not found at ${plistPath}\n`);
		return;
	}
	const home = toPosixPath(resolveHomeDir(env));
	const trashDir = path.posix.join(home, ".Trash");
	const dest = path.join(trashDir, `${label}.plist`);
	try {
		await fs.mkdir(trashDir, { recursive: true });
		await fs.rename(plistPath, dest);
		stdout.write(`${formatLine("Moved LaunchAgent to Trash", dest)}\n`);
	} catch {
		stdout.write(`LaunchAgent remains at ${plistPath} (could not move)\n`);
	}
}
function isLaunchctlNotLoaded(res) {
	const detail = (res.stderr || res.stdout).toLowerCase();
	return detail.includes("no such process") || detail.includes("could not find service") || detail.includes("not found");
}
function isUnsupportedGuiDomain(detail) {
	const normalized = detail.toLowerCase();
	return normalized.includes("domain does not support specified action") || normalized.includes("bootstrap failed: 125");
}
async function stopLaunchAgent({ stdout, env }) {
	const domain = resolveGuiDomain();
	const label = resolveLaunchAgentLabel({ env });
	const res = await execLaunchctl(["bootout", `${domain}/${label}`]);
	if (res.code !== 0 && !isLaunchctlNotLoaded(res)) throw new Error(`launchctl bootout failed: ${res.stderr || res.stdout}`.trim());
	stdout.write(`${formatLine("Stopped LaunchAgent", `${domain}/${label}`)}\n`);
}
async function installLaunchAgent({ env, stdout, programArguments, workingDirectory, environment, description }) {
	const { logDir, stdoutPath, stderrPath } = resolveGatewayLogPaths(env);
	await ensureSecureDirectory(logDir);
	const domain = resolveGuiDomain();
	const label = resolveLaunchAgentLabel({ env });
	for (const legacyLabel of resolveLegacyGatewayLaunchAgentLabels(env.OPENCLAW_PROFILE)) {
		const legacyPlistPath = resolveLaunchAgentPlistPathForLabel(env, legacyLabel);
		await execLaunchctl([
			"bootout",
			domain,
			legacyPlistPath
		]);
		await execLaunchctl(["unload", legacyPlistPath]);
		try {
			await fs.unlink(legacyPlistPath);
		} catch {}
	}
	const plistPath = resolveLaunchAgentPlistPathForLabel(env, label);
	const home = toPosixPath(resolveHomeDir(env));
	const libraryDir = path.posix.join(home, "Library");
	await ensureSecureDirectory(home);
	await ensureSecureDirectory(libraryDir);
	await ensureSecureDirectory(path.dirname(plistPath));
	const plist = buildLaunchAgentPlist({
		label,
		comment: resolveGatewayServiceDescription({
			env,
			environment,
			description
		}),
		programArguments,
		workingDirectory,
		stdoutPath,
		stderrPath,
		environment
	});
	await fs.writeFile(plistPath, plist, {
		encoding: "utf8",
		mode: LAUNCH_AGENT_PLIST_MODE
	});
	await fs.chmod(plistPath, LAUNCH_AGENT_PLIST_MODE).catch(() => void 0);
	await execLaunchctl([
		"bootout",
		domain,
		plistPath
	]);
	await execLaunchctl(["unload", plistPath]);
	await execLaunchctl(["enable", `${domain}/${label}`]);
	const boot = await execLaunchctl([
		"bootstrap",
		domain,
		plistPath
	]);
	if (boot.code !== 0) {
		const detail = (boot.stderr || boot.stdout).trim();
		if (isUnsupportedGuiDomain(detail)) throw new Error([
			`launchctl bootstrap failed: ${detail}`,
			`LaunchAgent install requires a logged-in macOS GUI session for this user (${domain}).`,
			"This usually means you are running from SSH/headless context or as the wrong user (including sudo).",
			"Fix: sign in to the macOS desktop as the target user and rerun `openclaw gateway install --force`.",
			"Headless deployments should use a dedicated logged-in user session or a custom LaunchDaemon (not shipped): https://docs.openclaw.ai/gateway"
		].join("\n"));
		throw new Error(`launchctl bootstrap failed: ${detail}`);
	}
	await execLaunchctl([
		"kickstart",
		"-k",
		`${domain}/${label}`
	]);
	writeFormattedLines(stdout, [{
		label: "Installed LaunchAgent",
		value: plistPath
	}, {
		label: "Logs",
		value: stdoutPath
	}], { leadingBlankLine: true });
	return { plistPath };
}
async function restartLaunchAgent({ stdout, env }) {
	const serviceEnv = env ?? process.env;
	const domain = resolveGuiDomain();
	const label = resolveLaunchAgentLabel({ env: serviceEnv });
	const plistPath = resolveLaunchAgentPlistPath(serviceEnv);
	const serviceTarget = `${domain}/${label}`;
	if (isCurrentProcessLaunchdServiceLabel(label)) {
		const handoff = scheduleDetachedLaunchdRestartHandoff({
			env: serviceEnv,
			mode: "kickstart",
			waitForPid: process.pid
		});
		if (!handoff.ok) throw new Error(`launchd restart handoff failed: ${handoff.detail ?? "unknown error"}`);
		try {
			stdout.write(`${formatLine("Scheduled LaunchAgent restart", serviceTarget)}\n`);
		} catch (err) {
			if (err?.code !== "EPIPE") throw err;
		}
		return { outcome: "scheduled" };
	}
	const start = await execLaunchctl([
		"kickstart",
		"-k",
		serviceTarget
	]);
	if (start.code === 0) {
		try {
			stdout.write(`${formatLine("Restarted LaunchAgent", serviceTarget)}\n`);
		} catch (err) {
			if (err?.code !== "EPIPE") throw err;
		}
		return { outcome: "completed" };
	}
	if (!isLaunchctlNotLoaded(start)) throw new Error(`launchctl kickstart failed: ${start.stderr || start.stdout}`.trim());
	await execLaunchctl(["enable", serviceTarget]);
	const boot = await execLaunchctl([
		"bootstrap",
		domain,
		plistPath
	]);
	if (boot.code !== 0) {
		const detail = (boot.stderr || boot.stdout).trim();
		if (isUnsupportedGuiDomain(detail)) throw new Error([
			`launchctl bootstrap failed: ${detail}`,
			`LaunchAgent restart requires a logged-in macOS GUI session for this user (${domain}).`,
			"This usually means you are running from SSH/headless context or as the wrong user (including sudo).",
			"Fix: sign in to the macOS desktop as the target user and rerun `openclaw gateway restart`.",
			"Headless deployments should use a dedicated logged-in user session or a custom LaunchDaemon (not shipped): https://docs.openclaw.ai/gateway"
		].join("\n"));
		throw new Error(`launchctl bootstrap failed: ${detail}`);
	}
	const retry = await execLaunchctl([
		"kickstart",
		"-k",
		serviceTarget
	]);
	if (retry.code !== 0) throw new Error(`launchctl kickstart failed: ${retry.stderr || retry.stdout}`.trim());
	try {
		stdout.write(`${formatLine("Restarted LaunchAgent", serviceTarget)}\n`);
	} catch (err) {
		if (err?.code !== "EPIPE") throw err;
	}
	return { outcome: "completed" };
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
		const content = await fs.readFile(scriptPath, "utf8");
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
function parseSchtasksQuery(output) {
	const entries = parseKeyValueOutput(output, ":");
	const info = {};
	const status = entries.status;
	if (status) info.status = status;
	const lastRunTime = entries["last run time"];
	if (lastRunTime) info.lastRunTime = lastRunTime;
	const lastRunResult = entries["last run result"];
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
		await fs.access(resolveStartupEntryPath(env));
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
async function resolveFallbackRuntime(env) {
	const port = resolveConfiguredGatewayPort(env);
	if (!port) return {
		status: "unknown",
		detail: "Startup-folder login item installed; gateway port unknown."
	};
	const diagnostics = await inspectPortUsage(port).catch(() => null);
	if (!diagnostics) return {
		status: "unknown",
		detail: `Startup-folder login item installed; could not inspect port ${port}.`
	};
	const listener = diagnostics.listeners.find((item) => typeof item.pid === "number");
	return {
		status: diagnostics.status === "busy" ? "running" : "stopped",
		...listener?.pid ? { pid: listener.pid } : {},
		detail: diagnostics.status === "busy" ? `Startup-folder login item installed; listener detected on port ${port}.` : `Startup-folder login item installed; no listener detected on port ${port}.`
	};
}
async function stopStartupEntry(env, stdout) {
	const runtime = await resolveFallbackRuntime(env);
	if (typeof runtime.pid === "number" && runtime.pid > 0) killProcessTree(runtime.pid, { graceMs: 300 });
	stdout.write(`${formatLine("Stopped Windows login item", resolveTaskName(env))}\n`);
}
async function restartStartupEntry(env, stdout) {
	const runtime = await resolveFallbackRuntime(env);
	if (typeof runtime.pid === "number" && runtime.pid > 0) killProcessTree(runtime.pid, { graceMs: 300 });
	launchFallbackTaskScript(resolveTaskScriptPath(env));
	stdout.write(`${formatLine("Restarted Windows login item", resolveTaskName(env))}\n`);
	return { outcome: "completed" };
}
async function installScheduledTask({ env, stdout, programArguments, workingDirectory, environment, description }) {
	await assertSchtasksAvailable();
	const scriptPath = resolveTaskScriptPath(env);
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
			await fs.mkdir(path.dirname(startupEntryPath), { recursive: true });
			const launcher = buildStartupLauncherScript({
				description: taskDescription,
				scriptPath
			});
			await fs.writeFile(startupEntryPath, launcher, "utf8");
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
		await fs.unlink(startupEntryPath);
		stdout.write(`${formatLine("Removed Windows login item", startupEntryPath)}\n`);
	} catch {}
	const scriptPath = resolveTaskScriptPath(env);
	try {
		await fs.unlink(scriptPath);
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
export { isLaunchAgentLoaded as a, resolveGatewayLogPaths as c, isLaunchAgentListed as i, resolveLaunchAgentPlistPath as l, resolveGatewayService as n, launchAgentPlistExists as o, execSchtasks as r, repairLaunchAgentBootstrap as s, describeGatewayServiceRestart as t, scheduleDetachedLaunchdRestartHandoff as u };
