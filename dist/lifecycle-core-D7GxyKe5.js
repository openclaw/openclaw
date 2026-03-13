import { A as theme, N as getResolvedLoggerSettings, O as colorize, k as isRich, p as defaultRuntime } from "./subsystem-DVwhOlEq.js";
import { d as resolveIsNixMode } from "./paths-BfR2LXbA.js";
import { Dh as isGatewaySecretRefUnavailableError, Hg as readConfigFileSnapshot, Oh as resolveGatewayDriftCheckCredentialsFromConfig, Vg as readBestEffortConfig } from "./auth-profiles-CAw5gP6f.js";
import { t as formatCliCommand } from "./command-format-CO3N-oGG.js";
import { r as isWSL } from "./fetch-ZNxqGXAR.js";
import { _ as resolveGatewayWindowsTaskName, g as resolveGatewaySystemdServiceName, p as resolveGatewayLaunchAgentLabel } from "./prompt-style-2BF77KhS.js";
import { n as formatConfigIssueLines } from "./issue-format-jHeRIpoa.js";
import { i as isSystemdUserServiceAvailable } from "./systemd-DuQVc30D.js";
import { t as describeGatewayServiceRestart } from "./service-DB3y-xDN.js";
import { a as checkTokenDrift, c as buildPlatformRuntimeLogHints, l as buildPlatformServiceStartHints, n as renderSystemdUnavailableHints } from "./systemd-hints-B-g2-fu9.js";
import { t as parsePort } from "./parse-port-CS-89LRy.js";
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
		if (!params.json) return;
		emitDaemonActionJson({
			action: params.action,
			...payload,
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
function renderRuntimeHints(runtime, env = process.env) {
	if (!runtime) return [];
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
	return buildPlatformServiceStartHints({
		installCommand: formatCliCommand("openclaw gateway install", env),
		startCommand: formatCliCommand("openclaw gateway", env),
		launchAgentPlistPath: `~/Library/LaunchAgents/${resolveGatewayLaunchAgentLabel(profile)}.plist`,
		systemdServiceName: resolveGatewaySystemdServiceName(profile),
		windowsTaskName: resolveGatewayWindowsTaskName(profile)
	});
}
//#endregion
//#region src/cli/daemon-cli/gateway-token-drift.ts
function resolveGatewayTokenForDriftCheck(params) {
	params.env;
	return resolveGatewayDriftCheckCredentialsFromConfig({ cfg: params.cfg }).token;
}
//#endregion
//#region src/cli/daemon-cli/lifecycle-core.ts
async function maybeAugmentSystemdHints(hints) {
	if (process.platform !== "linux") return hints;
	if (await isSystemdUserServiceAvailable().catch(() => false)) return hints;
	return [...hints, ...renderSystemdUnavailableHints({ wsl: await isWSL() })];
}
function createActionIO(params) {
	const stdout = params.json ? createNullWriter() : process.stdout;
	const emit = (payload) => {
		if (!params.json) return;
		emitDaemonActionJson({
			action: params.action,
			...payload
		});
	};
	const fail = (message, hints) => {
		if (params.json) emit({
			ok: false,
			error: message,
			hints
		});
		else defaultRuntime.error(message);
		defaultRuntime.exit(1);
	};
	return {
		stdout,
		emit,
		fail
	};
}
async function handleServiceNotLoaded(params) {
	const hints = await maybeAugmentSystemdHints(params.renderStartHints());
	params.emit({
		ok: true,
		result: "not-loaded",
		message: `${params.serviceNoun} service ${params.service.notLoadedText}.`,
		hints,
		service: buildDaemonServiceSnapshot(params.service, params.loaded)
	});
	if (!params.json) {
		defaultRuntime.log(`${params.serviceNoun} service ${params.service.notLoadedText}.`);
		for (const hint of hints) defaultRuntime.log(`Start with: ${hint}`);
	}
}
async function resolveServiceLoadedOrFail(params) {
	try {
		return await params.service.isLoaded({ env: process.env });
	} catch (err) {
		params.fail(`${params.serviceNoun} service check failed: ${String(err)}`);
		return null;
	}
}
/**
* Best-effort config validation. Returns a string describing the issues if
* config exists and is invalid, or null if config is valid/missing/unreadable.
*
* Note: This reads the config file snapshot in the current CLI environment.
* Configs using env vars only available in the service context (launchd/systemd)
* may produce false positives, but the check is intentionally best-effort —
* a false positive here is safer than a crash on startup. (#35862)
*/
async function getConfigValidationError() {
	try {
		const snapshot = await readConfigFileSnapshot();
		if (!snapshot.exists || snapshot.valid) return null;
		return snapshot.issues.length > 0 ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n") : "Unknown validation issue.";
	} catch {
		return null;
	}
}
async function runServiceUninstall(params) {
	const { stdout, emit, fail } = createActionIO({
		action: "uninstall",
		json: Boolean(params.opts?.json)
	});
	if (resolveIsNixMode(process.env)) {
		fail("Nix mode detected; service uninstall is disabled.");
		return;
	}
	let loaded = false;
	try {
		loaded = await params.service.isLoaded({ env: process.env });
	} catch {
		loaded = false;
	}
	if (loaded && params.stopBeforeUninstall) try {
		await params.service.stop({
			env: process.env,
			stdout
		});
	} catch {}
	try {
		await params.service.uninstall({
			env: process.env,
			stdout
		});
	} catch (err) {
		fail(`${params.serviceNoun} uninstall failed: ${String(err)}`);
		return;
	}
	loaded = false;
	try {
		loaded = await params.service.isLoaded({ env: process.env });
	} catch {
		loaded = false;
	}
	if (loaded && params.assertNotLoadedAfterUninstall) {
		fail(`${params.serviceNoun} service still loaded after uninstall.`);
		return;
	}
	emit({
		ok: true,
		result: "uninstalled",
		service: buildDaemonServiceSnapshot(params.service, loaded)
	});
}
async function runServiceStart(params) {
	const json = Boolean(params.opts?.json);
	const { stdout, emit, fail } = createActionIO({
		action: "start",
		json
	});
	const loaded = await resolveServiceLoadedOrFail({
		serviceNoun: params.serviceNoun,
		service: params.service,
		fail
	});
	if (loaded === null) return;
	if (!loaded) {
		await handleServiceNotLoaded({
			serviceNoun: params.serviceNoun,
			service: params.service,
			loaded,
			renderStartHints: params.renderStartHints,
			json,
			emit
		});
		return;
	}
	{
		const configError = await getConfigValidationError();
		if (configError) {
			fail(`${params.serviceNoun} aborted: config is invalid.\n${configError}\nFix the config and retry, or run "openclaw doctor" to repair.`);
			return;
		}
	}
	try {
		const restartResult = await params.service.restart({
			env: process.env,
			stdout
		});
		const restartStatus = describeGatewayServiceRestart(params.serviceNoun, restartResult);
		if (restartStatus.scheduled) {
			emit({
				ok: true,
				result: restartStatus.daemonActionResult,
				message: restartStatus.message,
				service: buildDaemonServiceSnapshot(params.service, loaded)
			});
			if (!json) defaultRuntime.log(restartStatus.message);
			return;
		}
	} catch (err) {
		const hints = params.renderStartHints();
		fail(`${params.serviceNoun} start failed: ${String(err)}`, hints);
		return;
	}
	let started = true;
	try {
		started = await params.service.isLoaded({ env: process.env });
	} catch {
		started = true;
	}
	emit({
		ok: true,
		result: "started",
		service: buildDaemonServiceSnapshot(params.service, started)
	});
}
async function runServiceStop(params) {
	const json = Boolean(params.opts?.json);
	const { stdout, emit, fail } = createActionIO({
		action: "stop",
		json
	});
	const loaded = await resolveServiceLoadedOrFail({
		serviceNoun: params.serviceNoun,
		service: params.service,
		fail
	});
	if (loaded === null) return;
	if (!loaded) {
		try {
			const handled = await params.onNotLoaded?.({
				json,
				stdout,
				fail
			});
			if (handled) {
				emit({
					ok: true,
					result: handled.result,
					message: handled.message,
					warnings: handled.warnings,
					service: buildDaemonServiceSnapshot(params.service, false)
				});
				if (!json && handled.message) defaultRuntime.log(handled.message);
				return;
			}
		} catch (err) {
			fail(`${params.serviceNoun} stop failed: ${String(err)}`);
			return;
		}
		emit({
			ok: true,
			result: "not-loaded",
			message: `${params.serviceNoun} service ${params.service.notLoadedText}.`,
			service: buildDaemonServiceSnapshot(params.service, loaded)
		});
		if (!json) defaultRuntime.log(`${params.serviceNoun} service ${params.service.notLoadedText}.`);
		return;
	}
	try {
		await params.service.stop({
			env: process.env,
			stdout
		});
	} catch (err) {
		fail(`${params.serviceNoun} stop failed: ${String(err)}`);
		return;
	}
	let stopped = false;
	try {
		stopped = await params.service.isLoaded({ env: process.env });
	} catch {
		stopped = false;
	}
	emit({
		ok: true,
		result: "stopped",
		service: buildDaemonServiceSnapshot(params.service, stopped)
	});
}
async function runServiceRestart(params) {
	const json = Boolean(params.opts?.json);
	const { stdout, emit, fail } = createActionIO({
		action: "restart",
		json
	});
	const warnings = [];
	let handledNotLoaded = null;
	const loaded = await resolveServiceLoadedOrFail({
		serviceNoun: params.serviceNoun,
		service: params.service,
		fail
	});
	if (loaded === null) return false;
	{
		const configError = await getConfigValidationError();
		if (configError) {
			fail(`${params.serviceNoun} aborted: config is invalid.\n${configError}\nFix the config and retry, or run "openclaw doctor" to repair.`);
			return false;
		}
	}
	if (!loaded) {
		try {
			handledNotLoaded = await params.onNotLoaded?.({
				json,
				stdout,
				fail
			}) ?? null;
		} catch (err) {
			fail(`${params.serviceNoun} restart failed: ${String(err)}`);
			return false;
		}
		if (!handledNotLoaded) {
			await handleServiceNotLoaded({
				serviceNoun: params.serviceNoun,
				service: params.service,
				loaded,
				renderStartHints: params.renderStartHints,
				json,
				emit
			});
			return false;
		}
		if (handledNotLoaded.warnings?.length) warnings.push(...handledNotLoaded.warnings);
	}
	if (loaded && params.checkTokenDrift) try {
		const serviceToken = (await params.service.readCommand(process.env))?.environment?.OPENCLAW_GATEWAY_TOKEN;
		const driftIssue = checkTokenDrift({
			serviceToken,
			configToken: resolveGatewayTokenForDriftCheck({
				cfg: await readBestEffortConfig(),
				env: process.env
			})
		});
		if (driftIssue) {
			const warning = driftIssue.detail ? `${driftIssue.message} ${driftIssue.detail}` : driftIssue.message;
			warnings.push(warning);
			if (!json) {
				defaultRuntime.log(`\n⚠️  ${driftIssue.message}`);
				if (driftIssue.detail) defaultRuntime.log(`   ${driftIssue.detail}\n`);
			}
		}
	} catch (err) {
		if (isGatewaySecretRefUnavailableError(err, "gateway.auth.token")) {
			const warning = "Unable to verify gateway token drift: gateway.auth.token SecretRef is configured but unavailable in this command path.";
			warnings.push(warning);
			if (!json) defaultRuntime.log(`\n⚠️  ${warning}\n`);
		}
	}
	try {
		let restartResult = { outcome: "completed" };
		if (loaded) restartResult = await params.service.restart({
			env: process.env,
			stdout
		});
		let restartStatus = describeGatewayServiceRestart(params.serviceNoun, restartResult);
		if (restartStatus.scheduled) {
			emit({
				ok: true,
				result: restartStatus.daemonActionResult,
				message: restartStatus.message,
				service: buildDaemonServiceSnapshot(params.service, loaded),
				warnings: warnings.length ? warnings : void 0
			});
			if (!json) defaultRuntime.log(restartStatus.message);
			return true;
		}
		if (params.postRestartCheck) {
			const postRestartResult = await params.postRestartCheck({
				json,
				stdout,
				warnings,
				fail
			});
			if (postRestartResult) {
				restartStatus = describeGatewayServiceRestart(params.serviceNoun, postRestartResult);
				if (restartStatus.scheduled) {
					emit({
						ok: true,
						result: restartStatus.daemonActionResult,
						message: restartStatus.message,
						service: buildDaemonServiceSnapshot(params.service, loaded),
						warnings: warnings.length ? warnings : void 0
					});
					if (!json) defaultRuntime.log(restartStatus.message);
					return true;
				}
			}
		}
		let restarted = loaded;
		if (loaded) try {
			restarted = await params.service.isLoaded({ env: process.env });
		} catch {
			restarted = true;
		}
		emit({
			ok: true,
			result: "restarted",
			message: handledNotLoaded?.message,
			service: buildDaemonServiceSnapshot(params.service, restarted),
			warnings: warnings.length ? warnings : void 0
		});
		if (!json && handledNotLoaded?.message) defaultRuntime.log(handledNotLoaded.message);
		return true;
	} catch (err) {
		const hints = params.renderStartHints();
		fail(`${params.serviceNoun} restart failed: ${String(err)}`, hints);
		return false;
	}
}
//#endregion
export { createCliStatusTextStyles as a, parsePortFromArgs as c, renderRuntimeHints as d, resolveRuntimeStatusColor as f, installDaemonServiceAndEmit as g, createDaemonActionContext as h, runServiceUninstall as i, pickProbeHostForBind as l, buildDaemonServiceSnapshot as m, runServiceStart as n, filterDaemonEnv as o, safeDaemonEnv as p, runServiceStop as r, normalizeListenerAddress as s, runServiceRestart as t, renderGatewayServiceStartHints as u };
