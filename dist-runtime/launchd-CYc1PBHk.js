import { d as resolveGatewayServiceDescription, l as resolveGatewayLaunchAgentLabel, m as resolveLegacyGatewayLaunchAgentLabels, t as GATEWAY_LAUNCH_AGENT_LABEL, x as parseStrictPositiveInteger, y as parseStrictInteger } from "./constants-C8ub4F0Y.js";
import { t as cleanStaleGatewayProcessesSync } from "./restart-stale-pids-Be6QOzfZ.js";
import { a as toPosixPath, i as formatLine, n as resolveGatewayStateDir, o as writeFormattedLines, r as resolveHomeDir, s as execFileUtf8, t as parseKeyValueOutput } from "./runtime-parse-DJmitJVt.js";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
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
function parseGatewayPortFromProgramArguments(programArguments) {
	if (!Array.isArray(programArguments) || programArguments.length === 0) return null;
	for (let index = 0; index < programArguments.length; index += 1) {
		const current = programArguments[index]?.trim();
		if (!current) continue;
		if (current === "--port") {
			const next = parseStrictPositiveInteger(programArguments[index + 1] ?? "");
			if (next !== void 0) return next;
			continue;
		}
		if (current.startsWith("--port=")) {
			const value = parseStrictPositiveInteger(current.slice(7));
			if (value !== void 0) return value;
		}
	}
	return null;
}
async function resolveLaunchAgentGatewayPort(env) {
	const fromArgs = parseGatewayPortFromProgramArguments((await readLaunchAgentProgramArguments(env).catch(() => null))?.programArguments);
	if (fromArgs !== null) return fromArgs;
	return parseStrictPositiveInteger(env.OPENCLAW_GATEWAY_PORT ?? "") ?? null;
}
function resolveGuiDomain() {
	if (typeof process.getuid !== "function") return "gui/501";
	return `gui/${process.getuid()}`;
}
function throwBootstrapGuiSessionError(params) {
	throw new Error([
		`launchctl bootstrap failed: ${params.detail}`,
		`LaunchAgent ${params.actionHint} requires a logged-in macOS GUI session for this user (${params.domain}).`,
		"This usually means you are running from SSH/headless context or as the wrong user (including sudo).",
		`Fix: sign in to the macOS desktop as the target user and rerun \`${params.actionHint}\`.`,
		"Headless deployments should use a dedicated logged-in user session or a custom LaunchDaemon (not shipped): https://docs.openclaw.ai/gateway"
	].join("\n"));
}
function writeLaunchAgentActionLine(stdout, label, value) {
	try {
		stdout.write(`${formatLine(label, value)}\n`);
	} catch (err) {
		if (err?.code !== "EPIPE") throw err;
	}
}
async function bootstrapLaunchAgentOrThrow(params) {
	await execLaunchctl(["enable", params.serviceTarget]);
	const boot = await execLaunchctl([
		"bootstrap",
		params.domain,
		params.plistPath
	]);
	if (boot.code === 0) return;
	const detail = (boot.stderr || boot.stdout).trim();
	if (isUnsupportedGuiDomain(detail)) throwBootstrapGuiSessionError({
		detail,
		domain: params.domain,
		actionHint: params.actionHint
	});
	throw new Error(`launchctl bootstrap failed: ${detail}`);
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
	await bootstrapLaunchAgentOrThrow({
		domain,
		serviceTarget: `${domain}/${label}`,
		plistPath,
		actionHint: "openclaw gateway install --force"
	});
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
		writeLaunchAgentActionLine(stdout, "Scheduled LaunchAgent restart", serviceTarget);
		return { outcome: "scheduled" };
	}
	const cleanupPort = await resolveLaunchAgentGatewayPort(serviceEnv);
	if (cleanupPort !== null) cleanStaleGatewayProcessesSync(cleanupPort);
	const start = await execLaunchctl([
		"kickstart",
		"-k",
		serviceTarget
	]);
	if (start.code === 0) {
		writeLaunchAgentActionLine(stdout, "Restarted LaunchAgent", serviceTarget);
		return { outcome: "completed" };
	}
	if (!isLaunchctlNotLoaded(start)) throw new Error(`launchctl kickstart failed: ${start.stderr || start.stdout}`.trim());
	await bootstrapLaunchAgentOrThrow({
		domain,
		serviceTarget,
		plistPath,
		actionHint: "openclaw gateway restart"
	});
	const retry = await execLaunchctl([
		"kickstart",
		"-k",
		serviceTarget
	]);
	if (retry.code !== 0) throw new Error(`launchctl kickstart failed: ${retry.stderr || retry.stdout}`.trim());
	writeLaunchAgentActionLine(stdout, "Restarted LaunchAgent", serviceTarget);
	return { outcome: "completed" };
}
//#endregion
export { readLaunchAgentProgramArguments as a, resolveGatewayLogPaths as c, stopLaunchAgent as d, uninstallLaunchAgent as f, launchAgentPlistExists as i, resolveLaunchAgentPlistPath as l, isLaunchAgentListed as n, readLaunchAgentRuntime as o, scheduleDetachedLaunchdRestartHandoff as p, isLaunchAgentLoaded as r, repairLaunchAgentBootstrap as s, installLaunchAgent as t, restartLaunchAgent as u };
