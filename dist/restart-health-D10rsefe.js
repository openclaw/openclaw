import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { _ as sleep } from "./utils-sBTEdeml.js";
import { r as createConfigIO } from "./io-DoswVvYe.js";
import { c as classifyPortListener, l as formatPortDiagnostics, o as inspectPortUsage } from "./ports-C3z_VZTO.js";
import { t as killProcessTree } from "./kill-tree-C3duXFqv.js";
import { a as probeGateway } from "./probe-VG0gCJ-9.js";
import { r as resolveGatewayProbeAuthSafeWithSecretInputs } from "./probe-auth-CbTbVDTG.js";
//#region src/cli/daemon-cli/restart-health.ts
const DEFAULT_RESTART_HEALTH_TIMEOUT_MS = 6e4;
const DEFAULT_RESTART_HEALTH_DELAY_MS = 500;
const DEFAULT_RESTART_HEALTH_ATTEMPTS = Math.ceil(DEFAULT_RESTART_HEALTH_TIMEOUT_MS / 500);
const STOPPED_FREE_EARLY_EXIT_GRACE_MS = 1e4;
const WINDOWS_STOPPED_FREE_EARLY_EXIT_GRACE_MS = 9e4;
function hasListenerAttributionGap(portUsage) {
	if (portUsage.status !== "busy" || portUsage.listeners.length > 0) return false;
	if (portUsage.errors?.length) return true;
	return portUsage.hints.some((hint) => hint.includes("process details are unavailable"));
}
function listenerOwnedByRuntimePid(params) {
	return params.listener.pid === params.runtimePid || params.listener.ppid === params.runtimePid;
}
function looksLikeAuthClose(code, reason) {
	if (code !== 1008) return false;
	const normalized = normalizeLowercaseStringOrEmpty(reason);
	if (!normalized) return false;
	return normalized === "auth required" || normalized === "owner auth required" || normalized === "connect failed" || normalized === "device required" || normalized === "pairing required" || normalized.startsWith("pairing required:") || normalized.startsWith("unauthorized: gateway token missing") || normalized.startsWith("unauthorized: gateway token mismatch") || normalized.startsWith("unauthorized: gateway token not configured") || normalized.startsWith("unauthorized: gateway password missing") || normalized.startsWith("unauthorized: gateway password mismatch") || normalized.startsWith("unauthorized: gateway password not configured") || normalized.startsWith("unauthorized: bootstrap token invalid or expired") || normalized.startsWith("unauthorized: tailscale identity missing") || normalized.startsWith("unauthorized: tailscale proxy headers missing") || normalized.startsWith("unauthorized: tailscale identity check failed") || normalized.startsWith("unauthorized: tailscale identity mismatch") || normalized.startsWith("unauthorized: too many failed authentication attempts") || normalized.startsWith("unauthorized: device token mismatch") || normalized.startsWith("unauthorized: device token rejected");
}
function applyExpectedVersion(snapshot, expectedVersion) {
	if (!expectedVersion) return snapshot;
	if (snapshot.gatewayVersion === expectedVersion) return {
		...snapshot,
		expectedVersion
	};
	if (snapshot.gatewayVersion == null) return {
		...snapshot,
		healthy: false,
		expectedVersion
	};
	return {
		...snapshot,
		healthy: false,
		expectedVersion,
		versionMismatch: {
			expected: expectedVersion,
			actual: snapshot.gatewayVersion ?? null
		}
	};
}
function readActivatedPluginErrors(health) {
	if (!health || typeof health !== "object") return [];
	const plugins = health.plugins;
	if (!plugins || typeof plugins !== "object") return [];
	const errors = plugins.errors;
	if (!Array.isArray(errors)) return [];
	return errors.filter((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const candidate = entry;
		return candidate.activated === true && typeof candidate.id === "string" && typeof candidate.error === "string";
	}).map((entry) => {
		const error = {
			id: entry.id,
			origin: typeof entry.origin === "string" ? entry.origin : "unknown",
			activated: true,
			error: entry.error
		};
		if (typeof entry.activationSource === "string") error.activationSource = entry.activationSource;
		if (typeof entry.activationReason === "string") error.activationReason = entry.activationReason;
		if (typeof entry.failurePhase === "string") error.failurePhase = entry.failurePhase;
		return error;
	});
}
function readChannelProbeErrors(health) {
	if (!health || typeof health !== "object") return [];
	const channels = health.channels;
	if (!channels || typeof channels !== "object" || Array.isArray(channels)) return [];
	const errors = [];
	for (const [id, summary] of Object.entries(channels)) {
		if (!summary || typeof summary !== "object") continue;
		const probe = summary.probe;
		if (!probe || typeof probe !== "object") continue;
		if (probe.ok !== false) continue;
		const error = probe.error;
		errors.push({
			id,
			error: typeof error === "string" && error.trim() ? error : "probe failed"
		});
	}
	return errors;
}
function applyActivatedPluginErrors(snapshot) {
	if (!snapshot.activatedPluginErrors?.length) return snapshot;
	return {
		...snapshot,
		healthy: false
	};
}
function applyChannelProbeErrors(snapshot) {
	if (!snapshot.channelProbeErrors?.length) return snapshot;
	return {
		...snapshot,
		healthy: false
	};
}
async function confirmGatewayReachable(params) {
	const token = normalizeOptionalString(params.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN);
	const password = normalizeOptionalString(params.auth?.password ?? process.env.OPENCLAW_GATEWAY_PASSWORD);
	const probe = await probeGateway({
		url: `ws://127.0.0.1:${params.port}`,
		auth: token || password ? {
			token,
			password
		} : void 0,
		timeoutMs: 3e3,
		includeDetails: params.includeHealthDetails === true,
		env: params.env
	});
	return {
		reachable: probe.ok || looksLikeAuthClose(probe.close?.code, probe.close?.reason) || probe.connectLatencyMs != null && probe.server?.version != null && probe.auth.capability === "connected_no_operator_scope",
		gatewayVersion: probe.server?.version ?? null,
		activatedPluginErrors: readActivatedPluginErrors(probe.health),
		channelProbeErrors: readChannelProbeErrors(probe.health)
	};
}
async function resolveGatewayRestartProbeAuth(env) {
	const mergedEnv = {
		...process.env,
		...env ?? void 0
	};
	return (await resolveGatewayProbeAuthSafeWithSecretInputs({
		cfg: await createConfigIO({
			env: mergedEnv,
			pluginValidation: "skip",
			suppressFutureVersionWarning: true
		}).readBestEffortConfig().catch(() => ({})),
		mode: "local",
		env: mergedEnv
	})).auth;
}
async function inspectGatewayPortHealth(params) {
	let portUsage;
	try {
		portUsage = await inspectPortUsage(params.port);
	} catch (err) {
		portUsage = {
			port: params.port,
			status: "unknown",
			listeners: [],
			hints: [],
			errors: [String(err)]
		};
	}
	let healthy = false;
	if (portUsage.status === "busy") try {
		healthy = (await confirmGatewayReachable({
			port: params.port,
			auth: params.auth,
			env: process.env
		})).reachable;
	} catch {}
	return {
		portUsage,
		healthy
	};
}
async function inspectGatewayRestart(params) {
	const env = params.env ?? process.env;
	const expectedVersion = normalizeOptionalString(params.expectedVersion);
	let reachability = null;
	let activatedPluginErrors = [];
	let channelProbeErrors = [];
	const loadReachability = async () => {
		if (!reachability) {
			reachability = await confirmGatewayReachable({
				port: params.port,
				includeHealthDetails: Boolean(expectedVersion),
				auth: params.probeAuth,
				env
			});
			activatedPluginErrors = reachability.activatedPluginErrors;
			channelProbeErrors = reachability.channelProbeErrors;
		}
		return reachability;
	};
	let runtime = { status: "unknown" };
	try {
		runtime = await params.service.readRuntime(env);
	} catch (err) {
		runtime = {
			status: "unknown",
			detail: String(err)
		};
	}
	let portUsage;
	try {
		portUsage = await inspectPortUsage(params.port);
	} catch (err) {
		portUsage = {
			port: params.port,
			status: "unknown",
			listeners: [],
			hints: [],
			errors: [String(err)]
		};
	}
	if (portUsage.status === "busy" && runtime.status !== "running") try {
		const reachable = await loadReachability();
		if (reachable.reachable) return applyChannelProbeErrors(applyActivatedPluginErrors(applyExpectedVersion({
			runtime,
			portUsage,
			healthy: true,
			staleGatewayPids: [],
			gatewayVersion: reachable.gatewayVersion,
			...reachable.activatedPluginErrors.length > 0 ? { activatedPluginErrors: reachable.activatedPluginErrors } : {},
			...reachable.channelProbeErrors.length > 0 ? { channelProbeErrors: reachable.channelProbeErrors } : {}
		}, expectedVersion)));
	} catch {}
	const gatewayListeners = portUsage.status === "busy" ? portUsage.listeners.filter((listener) => classifyPortListener(listener, params.port) === "gateway") : [];
	const fallbackListenerPids = params.includeUnknownListenersAsStale && process.platform === "win32" && runtime.status !== "running" && portUsage.status === "busy" ? portUsage.listeners.filter((listener) => classifyPortListener(listener, params.port) === "unknown").map((listener) => listener.pid).filter((pid) => Number.isFinite(pid)) : [];
	const running = runtime.status === "running";
	const runtimePid = runtime.pid;
	const listenerAttributionGap = hasListenerAttributionGap(portUsage);
	const ownsPort = runtimePid != null ? portUsage.listeners.some((listener) => listenerOwnedByRuntimePid({
		listener,
		runtimePid
	})) || listenerAttributionGap : gatewayListeners.length > 0 || listenerAttributionGap;
	let healthy = running && ownsPort;
	let gatewayVersion;
	if (expectedVersion && healthy && portUsage.status === "busy") try {
		const reachable = await loadReachability();
		healthy = reachable.reachable;
		gatewayVersion = reachable.gatewayVersion;
		if (reachable.activatedPluginErrors.length > 0) healthy = false;
		if (reachable.channelProbeErrors.length > 0) healthy = false;
	} catch {
		healthy = false;
	}
	if (!healthy && running && portUsage.status === "busy" && !expectedVersion) try {
		const reachable = await loadReachability();
		healthy = reachable.reachable;
		gatewayVersion = reachable.gatewayVersion;
	} catch {}
	const staleGatewayPids = Array.from(new Set([...gatewayListeners.filter((listener) => Number.isFinite(listener.pid)).filter((listener) => {
		if (!running) return true;
		if (runtimePid == null) return false;
		return !listenerOwnedByRuntimePid({
			listener,
			runtimePid
		});
	}).map((listener) => listener.pid), ...fallbackListenerPids.filter((pid) => runtime.pid == null || pid !== runtime.pid || !running)]));
	return applyChannelProbeErrors(applyActivatedPluginErrors(applyExpectedVersion({
		runtime,
		portUsage,
		healthy,
		staleGatewayPids,
		...gatewayVersion !== void 0 ? { gatewayVersion } : {},
		...activatedPluginErrors.length ? { activatedPluginErrors } : {},
		...channelProbeErrors.length ? { channelProbeErrors } : {}
	}, expectedVersion)));
}
function shouldEarlyExitStoppedFree(snapshot, attempt, minAttempt) {
	return attempt >= minAttempt && snapshot.runtime.status === "stopped" && snapshot.portUsage.status === "free";
}
function stoppedFreeEarlyExitGraceMs() {
	return process.platform === "win32" ? WINDOWS_STOPPED_FREE_EARLY_EXIT_GRACE_MS : STOPPED_FREE_EARLY_EXIT_GRACE_MS;
}
function withWaitContext(snapshot, waitOutcome, elapsedMs) {
	return {
		...snapshot,
		waitOutcome,
		elapsedMs
	};
}
async function waitForGatewayHealthyRestart(params) {
	const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
	const delayMs = params.delayMs ?? 500;
	const probeAuth = await resolveGatewayRestartProbeAuth(params.env).catch(() => void 0);
	let snapshot = await inspectGatewayRestart({
		service: params.service,
		port: params.port,
		env: params.env,
		expectedVersion: params.expectedVersion,
		includeUnknownListenersAsStale: params.includeUnknownListenersAsStale,
		probeAuth
	});
	let consecutiveStoppedFreeCount = 0;
	const STOPPED_FREE_THRESHOLD = 6;
	const minAttemptForEarlyExit = Math.min(Math.ceil(stoppedFreeEarlyExitGraceMs() / delayMs), Math.floor(attempts / 2));
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (snapshot.healthy) return withWaitContext(snapshot, "healthy", attempt * delayMs);
		if (snapshot.activatedPluginErrors?.length) return withWaitContext(snapshot, "plugin-errors", attempt * delayMs);
		if (snapshot.channelProbeErrors?.length) return withWaitContext(snapshot, "channel-errors", attempt * delayMs);
		if (snapshot.versionMismatch) return withWaitContext(snapshot, "version-mismatch", attempt * delayMs);
		if (snapshot.staleGatewayPids.length > 0 && snapshot.runtime.status !== "running") return withWaitContext(snapshot, "stale-pids", attempt * delayMs);
		if (shouldEarlyExitStoppedFree(snapshot, attempt, minAttemptForEarlyExit)) {
			consecutiveStoppedFreeCount += 1;
			if (consecutiveStoppedFreeCount >= STOPPED_FREE_THRESHOLD) return withWaitContext(snapshot, "stopped-free", attempt * delayMs);
		} else if (snapshot.runtime.status !== "stopped" || snapshot.portUsage.status !== "free") consecutiveStoppedFreeCount = 0;
		await sleep(delayMs);
		snapshot = await inspectGatewayRestart({
			service: params.service,
			port: params.port,
			env: params.env,
			expectedVersion: params.expectedVersion,
			includeUnknownListenersAsStale: params.includeUnknownListenersAsStale,
			probeAuth
		});
	}
	return withWaitContext(snapshot, "timeout", attempts * delayMs);
}
async function waitForGatewayHealthyListener(params) {
	const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
	const delayMs = params.delayMs ?? 500;
	const probeAuth = await resolveGatewayRestartProbeAuth(void 0).catch(() => void 0);
	let snapshot = await inspectGatewayPortHealth({
		port: params.port,
		auth: probeAuth
	});
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (snapshot.healthy) return snapshot;
		await sleep(delayMs);
		snapshot = await inspectGatewayPortHealth({
			port: params.port,
			auth: probeAuth
		});
	}
	return snapshot;
}
function renderPortUsageDiagnostics(snapshot) {
	const lines = [];
	if (snapshot.portUsage.status === "busy") lines.push(...formatPortDiagnostics(snapshot.portUsage));
	else lines.push(`Gateway port ${snapshot.portUsage.port} status: ${snapshot.portUsage.status}.`);
	if (snapshot.portUsage.errors?.length) lines.push(`Port diagnostics errors: ${snapshot.portUsage.errors.join("; ")}`);
	return lines;
}
function renderRestartDiagnostics(snapshot) {
	const lines = [];
	if (snapshot.versionMismatch) {
		const actual = snapshot.versionMismatch.actual ?? "unavailable";
		lines.push(`Gateway version mismatch: expected ${snapshot.versionMismatch.expected}, running gateway reported ${actual}.`);
	}
	if (snapshot.activatedPluginErrors?.length) {
		lines.push("Activated plugin load errors:");
		for (const plugin of snapshot.activatedPluginErrors) lines.push(`- ${plugin.id}: ${plugin.error}`);
	}
	if (snapshot.channelProbeErrors?.length) {
		lines.push("Channel health probe errors:");
		for (const channel of snapshot.channelProbeErrors) lines.push(`- ${channel.id}: ${channel.error}`);
	}
	const runtimeSummary = [
		snapshot.runtime.status ? `status=${snapshot.runtime.status}` : null,
		snapshot.runtime.state ? `state=${snapshot.runtime.state}` : null,
		snapshot.runtime.pid != null ? `pid=${snapshot.runtime.pid}` : null,
		snapshot.runtime.lastExitStatus != null ? `lastExit=${snapshot.runtime.lastExitStatus}` : null
	].filter(Boolean).join(", ");
	if (runtimeSummary) lines.push(`Service runtime: ${runtimeSummary}`);
	lines.push(...renderPortUsageDiagnostics(snapshot));
	return lines;
}
function renderGatewayPortHealthDiagnostics(snapshot) {
	return renderPortUsageDiagnostics(snapshot);
}
async function terminateStaleGatewayPids(pids) {
	const targets = Array.from(new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0)));
	for (const pid of targets) killProcessTree(pid, { graceMs: 300 });
	if (targets.length > 0) await sleep(500);
	return targets;
}
//#endregion
export { renderGatewayPortHealthDiagnostics as a, waitForGatewayHealthyListener as c, inspectGatewayRestart as i, waitForGatewayHealthyRestart as l, DEFAULT_RESTART_HEALTH_DELAY_MS as n, renderRestartDiagnostics as o, DEFAULT_RESTART_HEALTH_TIMEOUT_MS as r, terminateStaleGatewayPids as s, DEFAULT_RESTART_HEALTH_ATTEMPTS as t };
