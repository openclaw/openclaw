import { p as getResolvedLoggerSettings } from "./globals-I5DlBD2D.js";
import { d as resolveIsNixMode } from "./paths-1qR_mW4i.js";
import { n as isRich, r as theme, t as colorize } from "./theme-UkqnBJaj.js";
import { l as defaultRuntime } from "./subsystem-EnljYYs1.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import { f as resolveGatewaySystemdServiceName, l as resolveGatewayLaunchAgentLabel, p as resolveGatewayWindowsTaskName } from "./constants-C8ub4F0Y.js";
import { c as buildPlatformRuntimeLogHints, l as buildPlatformServiceStartHints } from "./systemd-hints-DDKGngJK.js";
import { t as parsePort } from "./parse-port-CfABYuqb.js";
import { Writable } from "node:stream";
//#region src/cli/daemon-cli/response.ts
function emitDaemonActionJson(payload) {
	defaultRuntime.log(JSON.stringify(payload, null, 2));
}
function buildDaemonServiceSnapshot(service, loaded) {
	return {
		label: service.label,
		loaded,
		loadedText: service.loadedText,
		notLoadedText: service.notLoadedText
	};
}
function createNullWriter() {
	return new Writable({ write(_chunk, _encoding, callback) {
		callback();
	} });
}
function createDaemonActionContext(params) {
	const warnings = [];
	const stdout = params.json ? createNullWriter() : process.stdout;
	const emit = (payload) => {
		if (!params.json) {return;}
		emitDaemonActionJson({
			action: params.action,
			...payload,
			warnings: payload.warnings ?? (warnings.length ? warnings : void 0)
		});
	};
	const fail = (message, hints) => {
		if (params.json) {emit({
			ok: false,
			error: message,
			hints
		});}
		else {
			defaultRuntime.error(message);
			if (hints?.length) {for (const hint of hints) defaultRuntime.log(`Tip: ${hint}`);}
		}
		defaultRuntime.exit(1);
	};
	return {
		stdout,
		warnings,
		emit,
		fail
	};
}
async function installDaemonServiceAndEmit(params) {
	try {
		await params.install();
	} catch (err) {
		params.fail(`${params.serviceNoun} install failed: ${String(err)}`);
		return;
	}
	let installed = true;
	try {
		installed = await params.service.isLoaded({ env: process.env });
	} catch {
		installed = true;
	}
	params.emit({
		ok: true,
		result: "installed",
		service: buildDaemonServiceSnapshot(params.service, installed),
		warnings: params.warnings.length ? params.warnings : void 0
	});
}
//#endregion
//#region src/cli/daemon-cli/shared.ts
function createDaemonInstallActionContext(jsonFlag) {
	const json = Boolean(jsonFlag);
	return {
		json,
		...createDaemonActionContext({
			action: "install",
			json
		})
	};
}
function failIfNixDaemonInstallMode(fail, env = process.env) {
	if (!resolveIsNixMode(env)) {return false;}
	fail("Nix mode detected; service install is disabled.");
	return true;
}
function createCliStatusTextStyles() {
	const rich = isRich();
	return {
		rich,
		label: (value) => colorize(rich, theme.muted, value),
		accent: (value) => colorize(rich, theme.accent, value),
		infoText: (value) => colorize(rich, theme.info, value),
		okText: (value) => colorize(rich, theme.success, value),
		warnText: (value) => colorize(rich, theme.warn, value),
		errorText: (value) => colorize(rich, theme.error, value)
	};
}
function resolveRuntimeStatusColor(status) {
	const runtimeStatus = status ?? "unknown";
	return runtimeStatus === "running" ? theme.success : runtimeStatus === "stopped" ? theme.error : runtimeStatus === "unknown" ? theme.muted : theme.warn;
}
function parsePortFromArgs(programArguments) {
	if (!programArguments?.length) {return null;}
	for (let i = 0; i < programArguments.length; i += 1) {
		const arg = programArguments[i];
		if (arg === "--port") {
			const next = programArguments[i + 1];
			const parsed = parsePort(next);
			if (parsed) {return parsed;}
		}
		if (arg?.startsWith("--port=")) {
			const parsed = parsePort(arg.split("=", 2)[1]);
			if (parsed) {return parsed;}
		}
	}
	return null;
}
function pickProbeHostForBind(bindMode, tailnetIPv4, customBindHost) {
	if (bindMode === "custom" && customBindHost?.trim()) {return customBindHost.trim();}
	if (bindMode === "tailnet") {return tailnetIPv4 ?? "127.0.0.1";}
	if (bindMode === "lan") {return "127.0.0.1";}
	return "127.0.0.1";
}
const SAFE_DAEMON_ENV_KEYS = [
	"OPENCLAW_PROFILE",
	"OPENCLAW_STATE_DIR",
	"OPENCLAW_CONFIG_PATH",
	"OPENCLAW_GATEWAY_PORT",
	"OPENCLAW_NIX_MODE"
];
function filterDaemonEnv(env) {
	if (!env) {return {};}
	const filtered = {};
	for (const key of SAFE_DAEMON_ENV_KEYS) {
		const value = env[key];
		if (!value?.trim()) {continue;}
		filtered[key] = value.trim();
	}
	return filtered;
}
function safeDaemonEnv(env) {
	const filtered = filterDaemonEnv(env);
	return Object.entries(filtered).map(([key, value]) => `${key}=${value}`);
}
function normalizeListenerAddress(raw) {
	let value = raw.trim();
	if (!value) {return value;}
	value = value.replace(/^TCP\s+/i, "");
	value = value.replace(/\s+\(LISTEN\)\s*$/i, "");
	return value.trim();
}
function renderRuntimeHints(runtime, env = process.env) {
	if (!runtime) {return [];}
	const hints = [];
	const fileLog = (() => {
		try {
			return getResolvedLoggerSettings().file;
		} catch {
			return null;
		}
	})();
	if (runtime.missingUnit) {
		hints.push(`Service not installed. Run: ${formatCliCommand("openclaw gateway install", env)}`);
		if (fileLog) {hints.push(`File logs: ${fileLog}`);}
		return hints;
	}
	if (runtime.status === "stopped") {
		if (fileLog) {hints.push(`File logs: ${fileLog}`);}
		hints.push(...buildPlatformRuntimeLogHints({
			env,
			systemdServiceName: resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE),
			windowsTaskName: resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE)
		}));
	}
	return hints;
}
function renderGatewayServiceStartHints(env = process.env) {
	const profile = env.OPENCLAW_PROFILE;
	return buildPlatformServiceStartHints({
		installCommand: formatCliCommand("openclaw gateway install", env),
		startCommand: formatCliCommand("openclaw gateway", env),
		launchAgentPlistPath: `~/Library/LaunchAgents/${resolveGatewayLaunchAgentLabel(profile)}.plist`,
		systemdServiceName: resolveGatewaySystemdServiceName(profile),
		windowsTaskName: resolveGatewayWindowsTaskName(profile)
	});
}
//#endregion
export { normalizeListenerAddress as a, renderGatewayServiceStartHints as c, safeDaemonEnv as d, buildDaemonServiceSnapshot as f, installDaemonServiceAndEmit as h, filterDaemonEnv as i, renderRuntimeHints as l, emitDaemonActionJson as m, createDaemonInstallActionContext as n, parsePortFromArgs as o, createNullWriter as p, failIfNixDaemonInstallMode as r, pickProbeHostForBind as s, createCliStatusTextStyles as t, resolveRuntimeStatusColor as u };
