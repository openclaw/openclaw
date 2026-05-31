import { normalizeText } from "../normalize-text.mjs";
import { isSessionIdentityPending, resolveSessionIdentityFromMeta } from "./session-identity.mjs";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
//#region src/runtime/session-identifiers.ts
const ACP_SESSION_IDENTITY_RENDERER_VERSION = "v1";
const ACP_AGENT_RESUME_HINT_BY_KEY = new Map([
	["codex", ({ agentSessionId }) => `resume in Codex CLI: \`codex resume ${agentSessionId}\` (continues this conversation).`],
	["openai", ({ agentSessionId }) => `resume in Codex CLI: \`codex resume ${agentSessionId}\` (continues this conversation).`],
	["codex-cli", ({ agentSessionId }) => `resume in Codex CLI: \`codex resume ${agentSessionId}\` (continues this conversation).`],
	["kimi", ({ agentSessionId }) => `resume in Kimi CLI: \`kimi resume ${agentSessionId}\` (continues this conversation).`],
	["moonshot-kimi", ({ agentSessionId }) => `resume in Kimi CLI: \`kimi resume ${agentSessionId}\` (continues this conversation).`]
]);
function normalizeAgentHintKey(value) {
	const normalized = normalizeText(value);
	if (!normalized) return;
	return normalizeLowercaseStringOrEmpty(normalized).replace(/[\s_]+/g, "-");
}
function resolveAcpAgentResumeHintLine(params) {
	const agentSessionId = normalizeText(params.agentSessionId);
	const agentKey = normalizeAgentHintKey(params.agentId);
	if (!agentSessionId || !agentKey) return;
	const resolver = ACP_AGENT_RESUME_HINT_BY_KEY.get(agentKey);
	return resolver ? resolver({ agentSessionId }) : void 0;
}
function resolveAcpSessionIdentifierLines(params) {
	return resolveAcpSessionIdentifierLinesFromIdentity({
		backend: normalizeText(params.meta?.backend) ?? "backend",
		identity: resolveSessionIdentityFromMeta(params.meta),
		mode: "status"
	});
}
function resolveAcpSessionIdentifierLinesFromIdentity(params) {
	const backend = normalizeText(params.backend) ?? "backend";
	const mode = params.mode ?? "status";
	const identity = params.identity;
	const agentSessionId = normalizeText(identity?.agentSessionId);
	const acpxSessionId = normalizeText(identity?.acpxSessionId);
	const acpxRecordId = normalizeText(identity?.acpxRecordId);
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
	const runtimeCwd = normalizeText(meta?.runtimeOptions?.cwd);
	if (runtimeCwd) return runtimeCwd;
	return normalizeText(meta?.cwd);
}
function resolveAcpThreadSessionDetailLines(params) {
	const meta = params.meta;
	const identity = resolveSessionIdentityFromMeta(meta);
	const lines = resolveAcpSessionIdentifierLinesFromIdentity({
		backend: normalizeText(meta?.backend) ?? "backend",
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
export { ACP_SESSION_IDENTITY_RENDERER_VERSION, resolveAcpSessionCwd, resolveAcpSessionIdentifierLines, resolveAcpSessionIdentifierLinesFromIdentity, resolveAcpThreadSessionDetailLines };
