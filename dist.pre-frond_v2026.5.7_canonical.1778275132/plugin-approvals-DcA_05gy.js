//#region src/infra/plugin-approvals.ts
const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 12e4;
const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 6e5;
const PLUGIN_APPROVAL_TITLE_MAX_LENGTH = 80;
const PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH = 256;
function approvalDecisionLabel(decision) {
	if (decision === "allow-once") return "allowed once";
	if (decision === "allow-always") return "allowed always";
	return "denied";
}
function buildPluginApprovalRequestMessage(request, nowMsValue) {
	const lines = [];
	const severity = request.request.severity ?? "warning";
	const icon = severity === "critical" ? "🚨" : severity === "info" ? "ℹ️" : "🛡️";
	lines.push(`${icon} Plugin approval required`);
	lines.push(`Title: ${request.request.title}`);
	lines.push(`Description: ${request.request.description}`);
	if (request.request.toolName) lines.push(`Tool: ${request.request.toolName}`);
	if (request.request.pluginId) lines.push(`Plugin: ${request.request.pluginId}`);
	if (request.request.agentId) lines.push(`Agent: ${request.request.agentId}`);
	lines.push(`ID: ${request.id}`);
	const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMsValue) / 1e3));
	lines.push(`Expires in: ${expiresIn}s`);
	lines.push("Reply with: /approve <id> allow-once|allow-always|deny");
	return lines.join("\n");
}
function buildPluginApprovalResolvedMessage(resolved) {
	return `${`✅ Plugin approval ${approvalDecisionLabel(resolved.decision)}.`}${resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : ""} ID: ${resolved.id}`;
}
function buildPluginApprovalExpiredMessage(request) {
	return `⏱️ Plugin approval expired. ID: ${request.id}`;
}
//#endregion
export { approvalDecisionLabel as a, buildPluginApprovalResolvedMessage as c, PLUGIN_APPROVAL_TITLE_MAX_LENGTH as i, MAX_PLUGIN_APPROVAL_TIMEOUT_MS as n, buildPluginApprovalExpiredMessage as o, PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH as r, buildPluginApprovalRequestMessage as s, DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS as t };
