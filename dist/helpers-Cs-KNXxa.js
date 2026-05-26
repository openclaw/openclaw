import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { d as resolveGatewayPort } from "./paths-Cw7f9XhU.js";
import { r as theme, t as colorize } from "./theme-D58JpUfy.js";
import { s as hasConfiguredSecretInput } from "./types.secrets-DwPik3M8.js";
import { i as isLoopbackHost } from "./net-DCUMtgJy.js";
import "./config-B6Oplu5W.js";
import { t as inspectBestEffortPrimaryTailnetIPv4 } from "./network-discovery-display-BExMsOxF.js";
import { n as parseTimeoutMsWithFallback } from "./parse-timeout-91AFhn8L.js";
import { n as resolveGatewayProbeSurfaceAuth } from "./auth-surface-resolution-DO1glHlZ.js";
//#region src/commands/gateway-status/helpers.ts
const MISSING_SCOPE_PATTERN = /\bmissing scope:\s*[a-z0-9._-]+/i;
function parseIntOrNull(value) {
	const s = typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "bigint" ? String(value) : "";
	if (!s) return null;
	const n = Number.parseInt(s, 10);
	return Number.isFinite(n) ? n : null;
}
function parseTimeoutMs(raw, fallbackMs) {
	return parseTimeoutMsWithFallback(raw, fallbackMs);
}
function normalizeWsUrl(value) {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) return null;
	return trimmed;
}
function resolveTargets(cfg, explicitUrl) {
	const targets = [];
	const add = (t) => {
		if (!targets.some((x) => x.url === t.url)) targets.push(t);
	};
	const explicit = typeof explicitUrl === "string" ? normalizeWsUrl(explicitUrl) : null;
	if (explicit) add({
		id: "explicit",
		kind: "explicit",
		url: explicit,
		active: true
	});
	const remoteUrl = typeof cfg.gateway?.remote?.url === "string" ? normalizeWsUrl(cfg.gateway.remote.url) : null;
	if (remoteUrl) add({
		id: "configRemote",
		kind: "configRemote",
		url: remoteUrl,
		active: cfg.gateway?.mode === "remote"
	});
	const port = resolveGatewayPort(cfg);
	add({
		id: "localLoopback",
		kind: "localLoopback",
		url: `${cfg.gateway?.tls?.enabled === true ? "wss" : "ws"}://127.0.0.1:${port}`,
		active: cfg.gateway?.mode !== "remote"
	});
	return targets;
}
function isLoopbackProbeTarget(target) {
	if (target.kind === "localLoopback") return true;
	try {
		return isLoopbackHost(new URL(target.url).hostname);
	} catch {
		return false;
	}
}
function resolveProbeBudgetMs(overallMs, target) {
	if (target.kind === "sshTunnel") return Math.min(2e3, overallMs);
	if (!isLoopbackProbeTarget(target)) return Math.min(1500, overallMs);
	if (target.kind === "localLoopback" && !target.active) return Math.min(800, overallMs);
	return overallMs;
}
function sanitizeSshTarget(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.replace(/^ssh\s+/, "");
}
async function resolveAuthForTarget(cfg, target, overrides) {
	const tokenOverride = normalizeOptionalString(overrides.token);
	const passwordOverride = normalizeOptionalString(overrides.password);
	if (tokenOverride || passwordOverride) return {
		token: tokenOverride,
		password: passwordOverride
	};
	return resolveGatewayProbeSurfaceAuth({
		config: cfg,
		surface: target.kind === "configRemote" || target.kind === "sshTunnel" ? "remote" : "local"
	});
}
function extractConfigSummary(snapshotUnknown) {
	const snap = snapshotUnknown;
	const path = typeof snap?.path === "string" ? snap.path : null;
	const exists = Boolean(snap?.exists);
	const valid = Boolean(snap?.valid);
	const issuesRaw = Array.isArray(snap?.issues) ? snap.issues : [];
	const legacyRaw = Array.isArray(snap?.legacyIssues) ? snap.legacyIssues : [];
	const cfg = snap?.config ?? {};
	const gateway = cfg.gateway ?? {};
	const secretDefaults = (cfg.secrets ?? {}).defaults ?? void 0;
	const wideArea = (cfg.discovery ?? {}).wideArea ?? {};
	const remote = gateway.remote ?? {};
	const auth = gateway.auth ?? {};
	const controlUi = gateway.controlUi ?? {};
	const tailscale = gateway.tailscale ?? {};
	const authMode = typeof auth.mode === "string" ? auth.mode : null;
	const authTokenConfigured = hasConfiguredSecretInput(auth.token, secretDefaults);
	const authPasswordConfigured = hasConfiguredSecretInput(auth.password, secretDefaults);
	const remoteUrl = typeof remote.url === "string" ? normalizeWsUrl(remote.url) : null;
	const remoteTokenConfigured = hasConfiguredSecretInput(remote.token, secretDefaults);
	const remotePasswordConfigured = hasConfiguredSecretInput(remote.password, secretDefaults);
	const wideAreaEnabled = typeof wideArea.enabled === "boolean" ? wideArea.enabled : null;
	return {
		path,
		exists,
		valid,
		issues: issuesRaw.filter((i) => i && typeof i.path === "string" && typeof i.message === "string").map((i) => ({
			path: i.path,
			message: i.message
		})),
		legacyIssues: legacyRaw.filter((i) => i && typeof i.path === "string" && typeof i.message === "string").map((i) => ({
			path: i.path,
			message: i.message
		})),
		gateway: {
			mode: typeof gateway.mode === "string" ? gateway.mode : null,
			bind: typeof gateway.bind === "string" ? gateway.bind : null,
			port: parseIntOrNull(gateway.port),
			controlUiEnabled: typeof controlUi.enabled === "boolean" ? controlUi.enabled : null,
			controlUiBasePath: typeof controlUi.basePath === "string" ? controlUi.basePath : null,
			authMode,
			authTokenConfigured,
			authPasswordConfigured,
			remoteUrl,
			remoteTokenConfigured,
			remotePasswordConfigured,
			tailscaleMode: typeof tailscale.mode === "string" ? tailscale.mode : null
		},
		discovery: { wideAreaEnabled }
	};
}
function buildNetworkHints(cfg) {
	const { tailnetIPv4 } = inspectBestEffortPrimaryTailnetIPv4();
	const port = resolveGatewayPort(cfg);
	const localScheme = cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
	return {
		localLoopbackUrl: `${localScheme}://127.0.0.1:${port}`,
		localTailnetUrl: tailnetIPv4 ? `${localScheme}://${tailnetIPv4}:${port}` : null,
		tailnetIPv4: tailnetIPv4 ?? null
	};
}
function renderTargetHeader(target, rich) {
	const kindLabel = target.kind === "localLoopback" ? "Local loopback" : target.kind === "sshTunnel" ? "Remote over SSH" : target.kind === "configRemote" ? target.active ? "Remote (configured)" : "Remote (configured, inactive)" : "URL (explicit)";
	return `${colorize(rich, theme.heading, kindLabel)} ${colorize(rich, theme.muted, target.url)}`;
}
function isScopeLimitedProbeFailure(probe) {
	if (probe.ok || probe.connectLatencyMs == null) return false;
	return MISSING_SCOPE_PATTERN.test(probe.error ?? "");
}
function isPostConnectProbeFailure(probe) {
	return !probe.ok && probe.connectLatencyMs != null;
}
function isProbeReachable(probe) {
	return probe.ok || probe.connectLatencyMs != null;
}
function getGatewayProbeCapability(probe) {
	return probe.auth.capability;
}
function summarizeGatewayProbeCapability(probes) {
	for (const capability of [
		"admin_capable",
		"write_capable",
		"read_only",
		"connected_no_operator_scope",
		"pairing_pending",
		"unknown"
	]) if (probes.some((probe) => getGatewayProbeCapability(probe) === capability)) return capability;
	return "unknown";
}
function formatGatewayProbeCapabilityLabel(capability) {
	switch (capability) {
		case "admin_capable": return "Capability: admin-capable";
		case "write_capable": return "Capability: write-capable";
		case "read_only": return "Capability: read-only";
		case "connected_no_operator_scope": return "Capability: connect-only";
		case "pairing_pending": return "Capability: pairing pending";
		default: return "Capability: unknown";
	}
}
function colorForGatewayProbeCapability(capability) {
	switch (capability) {
		case "admin_capable":
		case "write_capable":
		case "read_only": return theme.info;
		case "connected_no_operator_scope":
		case "pairing_pending": return theme.warn;
		default: return theme.muted;
	}
}
function renderProbeCapabilityLine(probe, rich) {
	const capability = getGatewayProbeCapability(probe);
	return colorize(rich, colorForGatewayProbeCapability(capability), formatGatewayProbeCapabilityLabel(capability));
}
function renderProbeSummaryLine(probe, rich) {
	const capability = renderProbeCapabilityLine(probe, rich);
	if (probe.ok) {
		const latency = typeof probe.connectLatencyMs === "number" ? `${probe.connectLatencyMs}ms` : "unknown";
		return `${colorize(rich, theme.success, "Connect: ok")} (${latency}) · ${capability} · ${colorize(rich, theme.success, "Read probe: ok")}`;
	}
	const detail = probe.error ? ` - ${probe.error}` : "";
	if (probe.connectLatencyMs != null) {
		const latency = typeof probe.connectLatencyMs === "number" ? `${probe.connectLatencyMs}ms` : "unknown";
		const readStatus = isScopeLimitedProbeFailure(probe) ? colorize(rich, theme.warn, "Read probe: limited") : colorize(rich, theme.error, "Read probe: failed");
		return `${colorize(rich, theme.success, "Connect: ok")} (${latency}) · ${capability} · ${readStatus}${detail}`;
	}
	if (getGatewayProbeCapability(probe) === "pairing_pending") return `${colorize(rich, theme.warn, "Connect: blocked")}${detail} · ${capability}`;
	return `${colorize(rich, theme.error, "Connect: failed")}${detail} · ${capability}`;
}
//#endregion
export { isScopeLimitedProbeFailure as a, renderTargetHeader as c, resolveTargets as d, sanitizeSshTarget as f, isProbeReachable as i, resolveAuthForTarget as l, extractConfigSummary as n, parseTimeoutMs as o, summarizeGatewayProbeCapability as p, isPostConnectProbeFailure as r, renderProbeSummaryLine as s, buildNetworkHints as t, resolveProbeBudgetMs as u };
