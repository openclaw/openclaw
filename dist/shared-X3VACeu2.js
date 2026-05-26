import { p as resolveIsNixMode } from "./paths-Cw7f9XhU.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { n as isRich, r as theme, t as colorize } from "./theme-D58JpUfy.js";
import { m as resolveGatewayWindowsTaskName, p as resolveGatewaySystemdServiceName, u as resolveGatewayLaunchAgentLabel } from "./constants-CmvvKVqh.js";
import { m as classifySystemdUnavailableDetail } from "./systemd-DsQkjgIm.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { a as isSystemdUnavailableDetail, i as resolveDaemonContainerContext, n as buildPlatformServiceStartHints, o as renderSystemdUnavailableHints, t as buildPlatformRuntimeLogHints } from "./runtime-hints-BcO9gSNA.js";
import { t as isWSL } from "./wsl-2-jVkfxN.js";
import { t as parsePort } from "./parse-port-m3bZnoBN.js";
import { Writable } from "node:stream";
//#region src/cli/daemon-cli/response.ts
function emitDaemonActionJson(payload) {
	defaultRuntime.writeJson(payload);
}
function classifyDaemonHintText(text) {
	if (text.includes("openclaw gateway install") || text.startsWith("Service not installed. Run:")) return "install";
	if (text.startsWith("Restart the container or the service that manages it for ")) return "container-restart";
	if (text.startsWith("systemd user services are unavailable;")) return "systemd-unavailable";
	if (text.startsWith("On a headless server (SSH/no desktop session):") || text.startsWith("Also ensure XDG_RUNTIME_DIR is set:")) return "systemd-headless";
	if (text.startsWith("If you're in a container, run the gateway in the foreground instead of")) return "container-foreground";
	if (text.startsWith("WSL2 needs systemd enabled:") || text.startsWith("Then run: wsl --shutdown") || text.startsWith("Verify: systemctl --user status")) return "wsl-systemd";
	return "generic";
}
function buildDaemonHintItems(hints) {
	if (!hints?.length) return;
	return hints.map((text) => ({
		kind: classifyDaemonHintText(text),
		text
	}));
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
		if (!params.json) return;
		emitDaemonActionJson({
			action: params.action,
			...payload,
			hintItems: payload.hintItems ?? buildDaemonHintItems(payload.hints),
			warnings: payload.warnings ?? (warnings.length ? warnings : void 0)
		});
	};
	const fail = (message, hints) => {
		if (params.json) emit({
			ok: false,
			error: message,
			hints
		});
		else {
			defaultRuntime.error(message);
			if (hints?.length) for (const hint of hints) defaultRuntime.log(`Tip: ${hint}`);
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
async function buildInstallFailureHints(error) {
	const detail = String(error);
	if (process.platform !== "linux" || !isSystemdUnavailableDetail(detail)) return;
	return renderSystemdUnavailableHints({
		wsl: await isWSL(),
		kind: classifySystemdUnavailableDetail(detail)
	});
}
async function installDaemonServiceAndEmit(params) {
	try {
		await params.install();
	} catch (err) {
		params.fail(`${params.serviceNoun} install failed: ${String(err)}`, await buildInstallFailureHints(err));
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
	if (!resolveIsNixMode(env)) return false;
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
	if (!programArguments?.length) return null;
	for (let i = 0; i < programArguments.length; i += 1) {
		const arg = programArguments[i];
		if (arg === "--port") {
			const next = programArguments[i + 1];
			const parsed = parsePort(next);
			if (parsed) return parsed;
		}
		if (arg?.startsWith("--port=")) {
			const parsed = parsePort(arg.split("=", 2)[1]);
			if (parsed) return parsed;
		}
	}
	return null;
}
function pickProbeHostForBind(bindMode, tailnetIPv4, customBindHost) {
	if (bindMode === "custom" && customBindHost?.trim()) return customBindHost.trim();
	if (bindMode === "tailnet") return tailnetIPv4 ?? "127.0.0.1";
	if (bindMode === "lan") return "127.0.0.1";
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
	if (!env) return {};
	const filtered = {};
	for (const key of SAFE_DAEMON_ENV_KEYS) {
		const value = env[key];
		if (!value?.trim()) continue;
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
	if (!value) return value;
	value = value.replace(/^TCP\s+/i, "");
	value = value.replace(/\s+\(LISTEN\)\s*$/i, "");
	return value.trim();
}
function renderRuntimeHints(runtime, env = process.env, logFile) {
	if (!runtime) return [];
	const hints = [];
	const fileLog = logFile ?? null;
	if (runtime.missingUnit) {
		hints.push(`Service not installed. Run: ${formatCliCommand("openclaw gateway install", env)}`);
		if (fileLog) hints.push(`File logs: ${fileLog}`);
		return hints;
	}
	if (runtime.missingSupervision) {
		hints.push(`LaunchAgent installed but not loaded. Run: ${formatCliCommand("openclaw gateway restart", env)}`);
		if (fileLog) hints.push(`File logs: ${fileLog}`);
		return hints;
	}
	if (runtime.status === "stopped") {
		if (fileLog) hints.push(`File logs: ${fileLog}`);
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
	const container = resolveDaemonContainerContext(env);
	const hints = buildPlatformServiceStartHints({
		installCommand: formatCliCommand("openclaw gateway install", env),
		startCommand: formatCliCommand("openclaw gateway", env),
		launchAgentPlistPath: `~/Library/LaunchAgents/${resolveGatewayLaunchAgentLabel(profile)}.plist`,
		systemdServiceName: resolveGatewaySystemdServiceName(profile),
		windowsTaskName: resolveGatewayWindowsTaskName(profile)
	});
	if (!container) return hints;
	return [`Restart the container or the service that manages it for ${container}.`];
}
function filterContainerGenericHints(hints, env = process.env) {
	if (!resolveDaemonContainerContext(env)) return hints;
	return hints.filter((hint) => !hint.includes("If you're in a container, run the gateway in the foreground instead of") && !hint.includes("systemd user services are unavailable; install/enable systemd"));
}
//#endregion
export { filterDaemonEnv as a, pickProbeHostForBind as c, resolveRuntimeStatusColor as d, safeDaemonEnv as f, installDaemonServiceAndEmit as h, filterContainerGenericHints as i, renderGatewayServiceStartHints as l, createDaemonActionContext as m, createDaemonInstallActionContext as n, normalizeListenerAddress as o, buildDaemonServiceSnapshot as p, failIfNixDaemonInstallMode as r, parsePortFromArgs as s, createCliStatusTextStyles as t, renderRuntimeHints as u };
