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
const LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES = ["clawdbot-gateway", "moltbot-gateway"];
function normalizeGatewayProfile(profile) {
	const trimmed = profile?.trim();
	if (!trimmed || trimmed.toLowerCase() === "default") return null;
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
export { resolveNodeWindowsTaskName as _, NODE_SERVICE_KIND as a, formatNodeServiceDescription as c, resolveGatewayServiceDescription as d, resolveGatewaySystemdServiceName as f, resolveNodeSystemdServiceName as g, resolveNodeLaunchAgentLabel as h, LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES as i, resolveGatewayLaunchAgentLabel as l, resolveLegacyGatewayLaunchAgentLabels as m, GATEWAY_SERVICE_KIND as n, NODE_SERVICE_MARKER as o, resolveGatewayWindowsTaskName as p, GATEWAY_SERVICE_MARKER as r, NODE_WINDOWS_TASK_SCRIPT_NAME as s, GATEWAY_LAUNCH_AGENT_LABEL as t, resolveGatewayProfileSuffix as u };