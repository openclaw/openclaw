import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { o as isSessionIdentityPending, u as resolveSessionIdentityFromMeta } from "./session-identity-MDZT82Pf.js";
//#region src/acp/runtime/session-identifiers.ts
const ACP_SESSION_IDENTITY_RENDERER_VERSION = "v1";
const ACP_AGENT_RESUME_HINT_BY_KEY = new Map([
	["codex", ({ agentSessionId }) => `resume in Codex CLI: \`codex resume ${agentSessionId}\` (continues this conversation).`],
	["openai-codex", ({ agentSessionId }) => `resume in Codex CLI: \`codex resume ${agentSessionId}\` (continues this conversation).`],
	["codex-cli", ({ agentSessionId }) => `resume in Codex CLI: \`codex resume ${agentSessionId}\` (continues this conversation).`],
	["kimi", ({ agentSessionId }) => `resume in Kimi CLI: \`kimi resume ${agentSessionId}\` (continues this conversation).`],
	["moonshot-kimi", ({ agentSessionId }) => `resume in Kimi CLI: \`kimi resume ${agentSessionId}\` (continues this conversation).`]
]);
function normalizeAgentHintKey(value) {
	const normalized = normalizeOptionalString(value);
	if (!normalized) return;
	return normalizeLowercaseStringOrEmpty(normalized).replace(/[\s_]+/g, "-");
}
function resolveAcpAgentResumeHintLine(params) {
	const agentSessionId = normalizeOptionalString(params.agentSessionId);
	const agentKey = normalizeAgentHintKey(params.agentId);
	if (!agentSessionId || !agentKey) return;
	const resolver = ACP_AGENT_RESUME_HINT_BY_KEY.get(agentKey);
	return resolver ? resolver({ agentSessionId }) : void 0;
}
function resolveAcpSessionIdentifierLines(params) {
	return resolveAcpSessionIdentifierLinesFromIdentity({
		backend: normalizeOptionalString(params.meta?.backend) ?? "backend",
		identity: resolveSessionIdentityFromMeta(params.meta),
		mode: "status"
	});
}
function resolveAcpSessionIdentifierLinesFromIdentity(params) {
	const backend = normalizeOptionalString(params.backend) ?? "backend";
	const mode = params.mode ?? "status";
	const identity = params.identity;
	const agentSessionId = normalizeOptionalString(identity?.agentSessionId);
	const acpxSessionId = normalizeOptionalString(identity?.acpxSessionId);
	const acpxRecordId = normalizeOptionalString(identity?.acpxRecordId);
	const hasIdentifier = Boolean(agentSessionId || acpxSessionId || acpxRecordId);
	if (isSessionIdentityPending(identity) && hasIdentifier) {
		if (mode === "status") return ["session ids: pending (available after the first reply)"];
		return [];
	}
	const lines = [];
	if (agentSessionId) lines.push(`agent session id: ${agentSessionId}`);
	if (acpxSessionId) lines.push(`${backend} session id: ${acpxSessionId}`);
	if (acpxRecordId) lines.push(`${backend} record id: ${acpxRecordId}`);
	return lines;
}
function resolveAcpSessionCwd(meta) {
	const runtimeCwd = normalizeOptionalString(meta?.runtimeOptions?.cwd);
	if (runtimeCwd) return runtimeCwd;
	return normalizeOptionalString(meta?.cwd);
}
function resolveAcpThreadSessionDetailLines(params) {
	const meta = params.meta;
	const identity = resolveSessionIdentityFromMeta(meta);
	const lines = resolveAcpSessionIdentifierLinesFromIdentity({
		backend: normalizeOptionalString(meta?.backend) ?? "backend",
		identity,
		mode: "thread"
	});
	if (lines.length === 0) return lines;
	const hint = resolveAcpAgentResumeHintLine({
		agentId: meta?.agent,
		agentSessionId: identity?.agentSessionId
	});
	if (hint) lines.push(hint);
	return lines;
}
//#endregion
export { resolveAcpThreadSessionDetailLines as a, resolveAcpSessionIdentifierLinesFromIdentity as i, resolveAcpSessionCwd as n, resolveAcpSessionIdentifierLines as r, ACP_SESSION_IDENTITY_RENDERER_VERSION as t };
