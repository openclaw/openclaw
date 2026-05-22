import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import path from "node:path";
//#region src/daemon/constants.ts
const GATEWAY_LAUNCH_AGENT_LABEL = "ai.openclaw.gateway";
const GATEWAY_SYSTEMD_SERVICE_NAME = "openclaw-gateway";
const GATEWAY_WINDOWS_TASK_NAME = "OpenClaw Gateway";
const GATEWAY_SERVICE_MARKER = "openclaw";
const GATEWAY_SERVICE_KIND = "gateway";
const NODE_LAUNCH_AGENT_LABEL = "ai.openclaw.node";
const NODE_SYSTEMD_SERVICE_NAME = "openclaw-node";
const NODE_WINDOWS_TASK_NAME = "OpenClaw Node";
const NODE_SERVICE_MARKER = "openclaw";
const NODE_SERVICE_KIND = "node";
const NODE_WINDOWS_TASK_SCRIPT_NAME = "node.cmd";
const LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES = ["clawdbot-gateway"];
function normalizeGatewayProfile(profile) {
	const trimmed = profile?.trim();
	if (!trimmed || normalizeLowercaseStringOrEmpty(trimmed) === "default") return null;
	return trimmed;
}
function resolveGatewayProfileSuffix(profile) {
	const normalized = normalizeGatewayProfile(profile);
	return normalized ? `-${normalized}` : "";
}
function resolveGatewayLaunchAgentLabel(profile) {
	const normalized = normalizeGatewayProfile(profile);
	if (!normalized) return GATEWAY_LAUNCH_AGENT_LABEL;
	return `ai.openclaw.${normalized}`;
}
function resolveLegacyGatewayLaunchAgentLabels(profile) {
	return [];
}
function resolveGatewaySystemdServiceName(profile) {
	const suffix = resolveGatewayProfileSuffix(profile);
	if (!suffix) return GATEWAY_SYSTEMD_SERVICE_NAME;
	return `openclaw-gateway${suffix}`;
}
function resolveGatewayWindowsTaskName(profile) {
	const normalized = normalizeGatewayProfile(profile);
	if (!normalized) return GATEWAY_WINDOWS_TASK_NAME;
	return `OpenClaw Gateway (${normalized})`;
}
function formatGatewayServiceDescription(params) {
	const profile = normalizeGatewayProfile(params?.profile);
	const version = params?.version?.trim();
	const parts = [];
	if (profile) parts.push(`profile: ${profile}`);
	if (version) parts.push(`v${version}`);
	if (parts.length === 0) return "OpenClaw Gateway";
	return `OpenClaw Gateway (${parts.join(", ")})`;
}
function resolveGatewayServiceDescription(params) {
	return params.description ?? formatGatewayServiceDescription({
		profile: params.env.OPENCLAW_PROFILE,
		version: params.environment?.OPENCLAW_SERVICE_VERSION ?? params.env.OPENCLAW_SERVICE_VERSION
	});
}
function resolveNodeLaunchAgentLabel() {
	return NODE_LAUNCH_AGENT_LABEL;
}
function resolveNodeSystemdServiceName() {
	return NODE_SYSTEMD_SERVICE_NAME;
}
function resolveNodeWindowsTaskName() {
	return NODE_WINDOWS_TASK_NAME;
}
function formatNodeServiceDescription(params) {
	const version = params?.version?.trim();
	if (!version) return "OpenClaw Node Host";
	return `OpenClaw Node Host (v${version})`;
}
//#endregion
//#region src/daemon/paths.ts
const windowsAbsolutePath = /^[a-zA-Z]:[\\/]/;
const windowsUncPath = /^\\\\/;
function resolveHomeDir(env) {
	const home = normalizeOptionalString(env.HOME) || normalizeOptionalString(env.USERPROFILE);
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
	const override = normalizeOptionalString(env.OPENCLAW_STATE_DIR);
	if (override) return resolveUserPathWithHome(override, override.startsWith("~") ? resolveHomeDir(env) : void 0);
	const home = resolveHomeDir(env);
	const suffix = resolveGatewayProfileSuffix(env.OPENCLAW_PROFILE);
	return path.join(home, `.openclaw${suffix}`);
}
//#endregion
export { resolveNodeSystemdServiceName as _, GATEWAY_SERVICE_MARKER as a, NODE_SERVICE_MARKER as c, resolveGatewayLaunchAgentLabel as d, resolveGatewayServiceDescription as f, resolveNodeLaunchAgentLabel as g, resolveLegacyGatewayLaunchAgentLabels as h, GATEWAY_SERVICE_KIND as i, NODE_WINDOWS_TASK_SCRIPT_NAME as l, resolveGatewayWindowsTaskName as m, resolveHomeDir as n, LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES as o, resolveGatewaySystemdServiceName as p, GATEWAY_LAUNCH_AGENT_LABEL as r, NODE_SERVICE_KIND as s, resolveGatewayStateDir as t, formatNodeServiceDescription as u, resolveNodeWindowsTaskName as v };
