import { A as theme, O as colorize, k as isRich } from "./subsystem-DBBM_0ww.js";
import { n as runExec, t as runCommandWithTimeout } from "./exec-eWx7-KTZ.js";
import { C as parseStrictInteger, T as parseStrictPositiveInteger, c as LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES, g as resolveGatewaySystemdServiceName, h as resolveGatewayServiceDescription, i as splitArgsPreservingQuotes, m as resolveGatewayProfileSuffix } from "./prompt-style-DxRe6Qmy.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
//#region src/daemon/exec-file.ts
async function execFileUtf8(command, args, options = {}) {
	return await new Promise((resolve) => {
		execFile(command, args, {
			...options,
			encoding: "utf8"
		}, (error, stdout, stderr) => {
			if (!error) {
				resolve({
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					code: 0
				});
				return;
			}
			const e = error;
			const stderrText = String(stderr ?? "");
			resolve({
				stdout: String(stdout ?? ""),
				stderr: stderrText || (typeof e.message === "string" ? e.message : typeof error === "string" ? error : ""),
				code: typeof e.code === "number" ? e.code : 1
			});
		});
	});
}
//#endregion
//#region src/daemon/output.ts
const toPosixPath = (value) => value.replace(/\\/g, "/");
function formatLine(label, value) {
	const rich = isRich();
	return `${colorize(rich, theme.muted, `${label}:`)} ${colorize(rich, theme.command, value)}`;
}
function writeFormattedLines(stdout, lines, opts) {
	if (opts?.leadingBlankLine) stdout.write("\n");
	for (const line of lines) stdout.write(`${formatLine(line.label, line.value)}\n`);
}
//#endregion
//#region src/daemon/paths.ts
const windowsAbsolutePath = /^[a-zA-Z]:[\\/]/;
const windowsUncPath = /^\\\\/;
function resolveHomeDir(env) {
	const home = env.HOME?.trim() || env.USERPROFILE?.trim();
	if (!home) throw new Error("Missing HOME");
	return home;
}
function resolveUserPathWithHome(input, home) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		if (!home) throw new Error("Missing HOME");
		const expanded = trimmed.replace(/^~(?=$|[\\/])/, home);
		return path.resolve(expanded);
	}
	if (windowsAbsolutePath.test(trimmed) || windowsUncPath.test(trimmed)) return trimmed;
	return path.resolve(trimmed);
}
function resolveGatewayStateDir(env) {
	const override = env.OPENCLAW_STATE_DIR?.trim();
	if (override) return resolveUserPathWithHome(override, override.startsWith("~") ? resolveHomeDir(env) : void 0);
	const home = resolveHomeDir(env);
	const suffix = resolveGatewayProfileSuffix(env.OPENCLAW_PROFILE);
	return path.join(home, `.openclaw${suffix}`);
}
//#endregion
//#region src/daemon/runtime-parse.ts
function parseKeyValueOutput(output, separator) {
	const entries = {};
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const idx = line.indexOf(separator);
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim().toLowerCase();
		if (!key) continue;
		entries[key] = line.slice(idx + separator.length).trim();
	}
	return entries;
}
//#endregion
//#region src/daemon/systemd-linger.ts
function resolveLoginctlUser(env) {
	const fromEnv = env.USER?.trim() || env.LOGNAME?.trim();
	if (fromEnv) return fromEnv;
	try {
		return os.userInfo().username;
	} catch {
		return null;
	}
}
async function readSystemdUserLingerStatus(env) {
	const user = resolveLoginctlUser(env);
	if (!user) return null;
	try {
		const { stdout } = await runExec("loginctl", [
			"show-user",
			user,
			"-p",
			"Linger"
		], { timeoutMs: 5e3 });
		const value = stdout.split("\n").map((entry) => entry.trim()).find((entry) => entry.startsWith("Linger="))?.split("=")[1]?.trim().toLowerCase();
		if (value === "yes" || value === "no") return {
			user,
			linger: value
		};
	} catch {}
	return null;
}
async function enableSystemdUserLinger(params) {
	const user = params.user ?? resolveLoginctlUser(params.env);
	if (!user) return {
		ok: false,
		stdout: "",
		stderr: "Missing user",
		code: 1
	};
	const argv = [
		...(typeof process.getuid === "function" ? process.getuid() !== 0 : true) && params.sudoMode !== void 0 ? ["sudo", ...params.sudoMode === "non-interactive" ? ["-n"] : []] : [],
		"loginctl",
		"enable-linger",
		user
	];
	try {
		const result = await runCommandWithTimeout(argv, { timeoutMs: 3e4 });
		return {
			ok: result.code === 0,
			stdout: result.stdout,
			stderr: result.stderr,
			code: result.code ?? 1
		};
	} catch (error) {
		return {
			ok: false,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
			code: 1
		};
	}
}
//#endregion
//#region src/daemon/systemd-unit.ts
const SYSTEMD_LINE_BREAKS = /[\r\n]/;
function assertNoSystemdLineBreaks(value, label) {
	if (SYSTEMD_LINE_BREAKS.test(value)) throw new Error(`${label} cannot contain CR or LF characters.`);
}
function systemdEscapeArg(value) {
	assertNoSystemdLineBreaks(value, "Systemd unit values");
	if (!/[\s"\\]/.test(value)) return value;
	return `"${value.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, "\\\\\"")}"`;
}
function renderEnvLines(env) {
	if (!env) return [];
	const entries = Object.entries(env).filter(([, value]) => typeof value === "string" && value.trim());
	if (entries.length === 0) return [];
	return entries.map(([key, value]) => {
		const rawValue = value ?? "";
		assertNoSystemdLineBreaks(key, "Systemd environment variable names");
		assertNoSystemdLineBreaks(rawValue, "Systemd environment variable values");
		return `Environment=${systemdEscapeArg(`${key}=${rawValue.trim()}`)}`;
	});
}
function buildSystemdUnit({ description, programArguments, workingDirectory, environment }) {
	const execStart = programArguments.map(systemdEscapeArg).join(" ");
	const descriptionValue = description?.trim() || "OpenClaw Gateway";
	assertNoSystemdLineBreaks(descriptionValue, "Systemd Description");
	const descriptionLine = `Description=${descriptionValue}`;
	const workingDirLine = workingDirectory ? `WorkingDirectory=${systemdEscapeArg(workingDirectory)}` : null;
	const envLines = renderEnvLines(environment);
	return [
		"[Unit]",
		descriptionLine,
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		`ExecStart=${execStart}`,
		"Restart=always",
		"RestartSec=5",
		"TimeoutStopSec=30",
		"TimeoutStartSec=30",
		"SuccessExitStatus=0 143",
		"KillMode=control-group",
		workingDirLine,
		...envLines,
		"",
		"[Install]",
		"WantedBy=default.target",
		""
	].filter((line) => line !== null).join("\n");
}
function parseSystemdExecStart(value) {
	return splitArgsPreservingQuotes(value, { escapeMode: "backslash" });
}
function parseSystemdEnvAssignment(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const unquoted = (() => {
		if (!(trimmed.startsWith("\"") && trimmed.endsWith("\""))) return trimmed;
		let out = "";
		let escapeNext = false;
		for (const ch of trimmed.slice(1, -1)) {
			if (escapeNext) {
				out += ch;
				escapeNext = false;
				continue;
			}
			if (ch === "\\\\") {
				escapeNext = true;
				continue;
			}
			out += ch;
		}
		return out;
	})();
	const eq = unquoted.indexOf("=");
	if (eq <= 0) return null;
	const key = unquoted.slice(0, eq).trim();
	if (!key) return null;
	return {
		key,
		value: unquoted.slice(eq + 1)
	};
}
//#endregion
//#region src/daemon/systemd.ts
function resolveSystemdUnitPathForName(env, name) {
	const home = toPosixPath(resolveHomeDir(env));
	return path.posix.join(home, ".config", "systemd", "user", `${name}.service`);
}
function resolveSystemdServiceName(env) {
	const override = env.OPENCLAW_SYSTEMD_UNIT?.trim();
	if (override) return override.endsWith(".service") ? override.slice(0, -8) : override;
	return resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
}
function resolveSystemdUnitPath(env) {
	return resolveSystemdUnitPathForName(env, resolveSystemdServiceName(env));
}
function resolveSystemdUserUnitPath(env) {
	return resolveSystemdUnitPath(env);
}
async function readSystemdServiceExecStart(env) {
	const unitPath = resolveSystemdUnitPath(env);
	try {
		const content = await fs.readFile(unitPath, "utf8");
		let execStart = "";
		let workingDirectory = "";
		const inlineEnvironment = {};
		const environmentFileSpecs = [];
		for (const rawLine of content.split("\n")) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			if (line.startsWith("ExecStart=")) execStart = line.slice(10).trim();
			else if (line.startsWith("WorkingDirectory=")) workingDirectory = line.slice(17).trim();
			else if (line.startsWith("Environment=")) {
				const parsed = parseSystemdEnvAssignment(line.slice(12).trim());
				if (parsed) inlineEnvironment[parsed.key] = parsed.value;
			} else if (line.startsWith("EnvironmentFile=")) {
				const raw = line.slice(16).trim();
				if (raw) environmentFileSpecs.push(raw);
			}
		}
		if (!execStart) return null;
		const environmentFromFiles = await resolveSystemdEnvironmentFiles({
			environmentFileSpecs,
			env,
			unitPath
		});
		const mergedEnvironment = {
			...inlineEnvironment,
			...environmentFromFiles.environment
		};
		const mergedEnvironmentSources = {
			...buildEnvironmentValueSources(inlineEnvironment, "inline"),
			...buildEnvironmentValueSources(environmentFromFiles.environment, "file")
		};
		return {
			programArguments: parseSystemdExecStart(execStart),
			...workingDirectory ? { workingDirectory } : {},
			...Object.keys(mergedEnvironment).length > 0 ? { environment: mergedEnvironment } : {},
			...Object.keys(mergedEnvironmentSources).length > 0 ? { environmentValueSources: mergedEnvironmentSources } : {},
			sourcePath: unitPath
		};
	} catch {
		return null;
	}
}
function buildEnvironmentValueSources(environment, source) {
	return Object.fromEntries(Object.keys(environment).map((key) => [key, source]));
}
function expandSystemdSpecifier(input, env) {
	return input.replaceAll("%h", toPosixPath(resolveHomeDir(env)));
}
function parseEnvironmentFileSpecs(raw) {
	return splitArgsPreservingQuotes(raw, { escapeMode: "backslash" }).map((entry) => entry.trim()).filter(Boolean);
}
function parseEnvironmentFileLine(rawLine) {
	const trimmed = rawLine.trim();
	if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return null;
	const eq = trimmed.indexOf("=");
	if (eq <= 0) return null;
	const key = trimmed.slice(0, eq).trim();
	if (!key) return null;
	let value = trimmed.slice(eq + 1).trim();
	if (value.length >= 2 && (value.startsWith("\"") && value.endsWith("\"") || value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
	return {
		key,
		value
	};
}
async function readSystemdEnvironmentFile(pathname) {
	const environment = {};
	const content = await fs.readFile(pathname, "utf8");
	for (const rawLine of content.split(/\r?\n/)) {
		const parsed = parseEnvironmentFileLine(rawLine);
		if (!parsed) continue;
		environment[parsed.key] = parsed.value;
	}
	return environment;
}
async function resolveSystemdEnvironmentFiles(params) {
	const resolved = {};
	if (params.environmentFileSpecs.length === 0) return { environment: resolved };
	const unitDir = path.posix.dirname(params.unitPath);
	for (const specRaw of params.environmentFileSpecs) for (const token of parseEnvironmentFileSpecs(specRaw)) {
		const pathnameRaw = token.startsWith("-") ? token.slice(1).trim() : token;
		if (!pathnameRaw) continue;
		const expanded = expandSystemdSpecifier(pathnameRaw, params.env);
		const pathname = path.posix.isAbsolute(expanded) ? expanded : path.posix.resolve(unitDir, expanded);
		try {
			const fromFile = await readSystemdEnvironmentFile(pathname);
			Object.assign(resolved, fromFile);
		} catch {
			continue;
		}
	}
	return { environment: resolved };
}
function parseSystemdShow(output) {
	const entries = parseKeyValueOutput(output, "=");
	const info = {};
	const activeState = entries.activestate;
	if (activeState) info.activeState = activeState;
	const subState = entries.substate;
	if (subState) info.subState = subState;
	const mainPidValue = entries.mainpid;
	if (mainPidValue) {
		const pid = parseStrictPositiveInteger(mainPidValue);
		if (pid !== void 0) info.mainPid = pid;
	}
	const execMainStatusValue = entries.execmainstatus;
	if (execMainStatusValue) {
		const status = parseStrictInteger(execMainStatusValue);
		if (status !== void 0) info.execMainStatus = status;
	}
	const execMainCode = entries.execmaincode;
	if (execMainCode) info.execMainCode = execMainCode;
	return info;
}
async function execSystemctl(args) {
	return await execFileUtf8("systemctl", args);
}
function readSystemctlDetail(result) {
	return `${result.stderr} ${result.stdout}`.trim();
}
function isSystemctlMissing(detail) {
	if (!detail) return false;
	const normalized = detail.toLowerCase();
	return normalized.includes("not found") || normalized.includes("no such file or directory") || normalized.includes("spawn systemctl enoent") || normalized.includes("spawn systemctl eacces");
}
function isSystemdUnitNotEnabled(detail) {
	if (!detail) return false;
	const normalized = detail.toLowerCase();
	return normalized.includes("disabled") || normalized.includes("static") || normalized.includes("indirect") || normalized.includes("masked") || normalized.includes("not-found") || normalized.includes("could not be found") || normalized.includes("failed to get unit file state");
}
function isSystemctlBusUnavailable(detail) {
	if (!detail) return false;
	const normalized = detail.toLowerCase();
	return normalized.includes("failed to connect to bus") || normalized.includes("failed to connect to user scope bus") || normalized.includes("dbus_session_bus_address") || normalized.includes("xdg_runtime_dir") || normalized.includes("no medium found");
}
function isSystemdUserScopeUnavailable(detail) {
	if (!detail) return false;
	const normalized = detail.toLowerCase();
	return isSystemctlMissing(normalized) || isSystemctlBusUnavailable(normalized) || normalized.includes("not been booted") || normalized.includes("not supported");
}
function isGenericSystemctlIsEnabledFailure(detail) {
	if (!detail) return false;
	const normalized = detail.toLowerCase().trim();
	return normalized.startsWith("command failed: systemctl") && normalized.includes(" is-enabled ") && !normalized.includes("permission denied") && !normalized.includes("access denied") && !normalized.includes("no space left") && !normalized.includes("read-only file system") && !normalized.includes("out of memory") && !normalized.includes("cannot allocate memory");
}
function isNonFatalSystemdInstallProbeError(error) {
	const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (!detail) return false;
	const normalized = detail.toLowerCase();
	return isSystemctlBusUnavailable(normalized) || isGenericSystemctlIsEnabledFailure(normalized);
}
function resolveSystemctlDirectUserScopeArgs() {
	return ["--user"];
}
function resolveSystemctlMachineScopeUser(env) {
	const sudoUser = env.SUDO_USER?.trim();
	if (sudoUser && sudoUser !== "root") return sudoUser;
	const fromEnv = env.USER?.trim() || env.LOGNAME?.trim();
	if (fromEnv) return fromEnv;
	try {
		return os.userInfo().username;
	} catch {
		return null;
	}
}
function resolveSystemctlMachineUserScopeArgs(user) {
	const trimmedUser = user.trim();
	if (!trimmedUser) return [];
	return [
		"--machine",
		`${trimmedUser}@`,
		"--user"
	];
}
function shouldFallbackToMachineUserScope(detail) {
	const normalized = detail.toLowerCase();
	return normalized.includes("failed to connect to bus") || normalized.includes("failed to connect to user scope bus") || normalized.includes("dbus_session_bus_address") || normalized.includes("xdg_runtime_dir");
}
async function execSystemctlUser(env, args) {
	const machineUser = resolveSystemctlMachineScopeUser(env);
	const sudoUser = env.SUDO_USER?.trim();
	if (sudoUser && sudoUser !== "root" && machineUser) {
		const machineScopeArgs = resolveSystemctlMachineUserScopeArgs(machineUser);
		if (machineScopeArgs.length > 0) return await execSystemctl([...machineScopeArgs, ...args]);
	}
	const directResult = await execSystemctl([...resolveSystemctlDirectUserScopeArgs(), ...args]);
	if (directResult.code === 0) return directResult;
	const detail = `${directResult.stderr} ${directResult.stdout}`.trim();
	if (!machineUser || !shouldFallbackToMachineUserScope(detail)) return directResult;
	const machineScopeArgs = resolveSystemctlMachineUserScopeArgs(machineUser);
	if (machineScopeArgs.length === 0) return directResult;
	return await execSystemctl([...machineScopeArgs, ...args]);
}
async function isSystemdUserServiceAvailable(env = process.env) {
	const res = await execSystemctlUser(env, ["status"]);
	if (res.code === 0) return true;
	const detail = `${res.stderr} ${res.stdout}`.trim();
	if (!detail) return false;
	return !isSystemdUserScopeUnavailable(detail);
}
async function assertSystemdAvailable(env = process.env) {
	const res = await execSystemctlUser(env, ["status"]);
	if (res.code === 0) return;
	const detail = readSystemctlDetail(res);
	if (isSystemctlMissing(detail)) throw new Error("systemctl not available; systemd user services are required on Linux.");
	if (!detail) throw new Error("systemctl --user unavailable: unknown error");
	if (!isSystemdUserScopeUnavailable(detail)) return;
	throw new Error(`systemctl --user unavailable: ${detail || "unknown error"}`.trim());
}
async function installSystemdService({ env, stdout, programArguments, workingDirectory, environment, description }) {
	await assertSystemdAvailable(env);
	const unitPath = resolveSystemdUnitPath(env);
	await fs.mkdir(path.dirname(unitPath), { recursive: true });
	let backedUp = false;
	try {
		await fs.access(unitPath);
		const backupPath = `${unitPath}.bak`;
		await fs.copyFile(unitPath, backupPath);
		backedUp = true;
	} catch {}
	const unit = buildSystemdUnit({
		description: resolveGatewayServiceDescription({
			env,
			environment,
			description
		}),
		programArguments,
		workingDirectory,
		environment
	});
	await fs.writeFile(unitPath, unit, "utf8");
	const unitName = `${resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE)}.service`;
	const reload = await execSystemctlUser(env, ["daemon-reload"]);
	if (reload.code !== 0) throw new Error(`systemctl daemon-reload failed: ${reload.stderr || reload.stdout}`.trim());
	const enable = await execSystemctlUser(env, ["enable", unitName]);
	if (enable.code !== 0) throw new Error(`systemctl enable failed: ${enable.stderr || enable.stdout}`.trim());
	const restart = await execSystemctlUser(env, ["restart", unitName]);
	if (restart.code !== 0) throw new Error(`systemctl restart failed: ${restart.stderr || restart.stdout}`.trim());
	writeFormattedLines(stdout, [{
		label: "Installed systemd service",
		value: unitPath
	}, ...backedUp ? [{
		label: "Previous unit backed up to",
		value: `${unitPath}.bak`
	}] : []], { leadingBlankLine: true });
	return { unitPath };
}
async function uninstallSystemdService({ env, stdout }) {
	await assertSystemdAvailable(env);
	await execSystemctlUser(env, [
		"disable",
		"--now",
		`${resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE)}.service`
	]);
	const unitPath = resolveSystemdUnitPath(env);
	try {
		await fs.unlink(unitPath);
		stdout.write(`${formatLine("Removed systemd service", unitPath)}\n`);
	} catch {
		stdout.write(`Systemd service not found at ${unitPath}\n`);
	}
}
async function runSystemdServiceAction(params) {
	const env = params.env ?? process.env;
	await assertSystemdAvailable(env);
	const unitName = `${resolveSystemdServiceName(env)}.service`;
	const res = await execSystemctlUser(env, [params.action, unitName]);
	if (res.code !== 0) throw new Error(`systemctl ${params.action} failed: ${res.stderr || res.stdout}`.trim());
	params.stdout.write(`${formatLine(params.label, unitName)}\n`);
}
async function stopSystemdService({ stdout, env }) {
	await runSystemdServiceAction({
		stdout,
		env,
		action: "stop",
		label: "Stopped systemd service"
	});
}
async function restartSystemdService({ stdout, env }) {
	await runSystemdServiceAction({
		stdout,
		env,
		action: "restart",
		label: "Restarted systemd service"
	});
	return { outcome: "completed" };
}
async function isSystemdServiceEnabled(args) {
	const env = args.env ?? process.env;
	try {
		await fs.access(resolveSystemdUnitPath(env));
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
	const res = await execSystemctlUser(env, ["is-enabled", `${resolveSystemdServiceName(env)}.service`]);
	if (res.code === 0) return true;
	const detail = readSystemctlDetail(res);
	if (isSystemctlMissing(detail) || isSystemdUnitNotEnabled(detail)) return false;
	throw new Error(`systemctl is-enabled unavailable: ${detail || "unknown error"}`.trim());
}
async function readSystemdServiceRuntime(env = process.env) {
	try {
		await assertSystemdAvailable(env);
	} catch (err) {
		return {
			status: "unknown",
			detail: err instanceof Error ? err.message : String(err)
		};
	}
	const res = await execSystemctlUser(env, [
		"show",
		`${resolveSystemdServiceName(env)}.service`,
		"--no-page",
		"--property",
		"ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode"
	]);
	if (res.code !== 0) {
		const detail = (res.stderr || res.stdout).trim();
		const missing = detail.toLowerCase().includes("not found");
		return {
			status: missing ? "stopped" : "unknown",
			detail: detail || void 0,
			missingUnit: missing
		};
	}
	const parsed = parseSystemdShow(res.stdout || "");
	const activeState = parsed.activeState?.toLowerCase();
	return {
		status: activeState === "active" ? "running" : activeState ? "stopped" : "unknown",
		state: parsed.activeState,
		subState: parsed.subState,
		pid: parsed.mainPid,
		lastExitStatus: parsed.execMainStatus,
		lastExitReason: parsed.execMainCode
	};
}
async function isSystemctlAvailable(env) {
	const res = await execSystemctlUser(env, ["status"]);
	if (res.code === 0) return true;
	return !isSystemctlMissing(readSystemctlDetail(res));
}
async function findLegacySystemdUnits(env) {
	const results = [];
	const systemctlAvailable = await isSystemctlAvailable(env);
	for (const name of LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES) {
		const unitPath = resolveSystemdUnitPathForName(env, name);
		let exists = false;
		try {
			await fs.access(unitPath);
			exists = true;
		} catch {}
		let enabled = false;
		if (systemctlAvailable) enabled = (await execSystemctlUser(env, ["is-enabled", `${name}.service`])).code === 0;
		if (exists || enabled) results.push({
			name,
			unitPath,
			enabled,
			exists
		});
	}
	return results;
}
async function uninstallLegacySystemdUnits({ env, stdout }) {
	const units = await findLegacySystemdUnits(env);
	if (units.length === 0) return units;
	const systemctlAvailable = await isSystemctlAvailable(env);
	for (const unit of units) {
		if (systemctlAvailable) await execSystemctlUser(env, [
			"disable",
			"--now",
			`${unit.name}.service`
		]);
		else stdout.write(`systemctl unavailable; removed legacy unit file only: ${unit.name}.service\n`);
		try {
			await fs.unlink(unit.unitPath);
			stdout.write(`${formatLine("Removed legacy systemd service", unit.unitPath)}\n`);
		} catch {
			stdout.write(`Legacy systemd unit not found at ${unit.unitPath}\n`);
		}
	}
	return units;
}
//#endregion
export { formatLine as _, readSystemdServiceExecStart as a, execFileUtf8 as b, restartSystemdService as c, uninstallSystemdService as d, enableSystemdUserLinger as f, resolveHomeDir as g, resolveGatewayStateDir as h, isSystemdUserServiceAvailable as i, stopSystemdService as l, parseKeyValueOutput as m, isNonFatalSystemdInstallProbeError as n, readSystemdServiceRuntime as o, readSystemdUserLingerStatus as p, isSystemdServiceEnabled as r, resolveSystemdUserUnitPath as s, installSystemdService as t, uninstallLegacySystemdUnits as u, toPosixPath as v, writeFormattedLines as y };
