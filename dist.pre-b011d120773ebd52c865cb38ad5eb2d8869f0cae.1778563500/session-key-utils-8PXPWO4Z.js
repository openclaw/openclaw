import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
//#region src/sessions/session-key-utils.ts
/**
* Parse agent-scoped session keys in a canonical, case-insensitive way.
* Returned values are normalized to lowercase for stable comparisons/routing.
*/
function parseAgentSessionKey(sessionKey) {
	const raw = normalizeOptionalLowercaseString(sessionKey);
	if (!raw) return null;
	const parts = raw.split(":").filter(Boolean);
	if (parts.length < 3) return null;
	if (parts[0] !== "agent") return null;
	const agentId = normalizeOptionalString(parts[1]);
	const rest = parts.slice(2).join(":");
	if (!agentId || !rest) return null;
	return {
		agentId,
		rest
	};
}
function isCronRunSessionKey(sessionKey) {
	const parsed = parseAgentSessionKey(sessionKey);
	if (!parsed) return false;
	return /^cron:[^:]+:run:[^:]+$/.test(parsed.rest);
}
function isCronSessionKey(sessionKey) {
	const parsed = parseAgentSessionKey(sessionKey);
	if (!parsed) return false;
	return normalizeOptionalLowercaseString(parsed.rest)?.startsWith("cron:") === true;
}
function isSubagentSessionKey(sessionKey) {
	const raw = normalizeOptionalString(sessionKey);
	if (!raw) return false;
	if (normalizeOptionalLowercaseString(raw)?.startsWith("subagent:")) return true;
	return normalizeOptionalLowercaseString(parseAgentSessionKey(raw)?.rest)?.startsWith("subagent:") === true;
}
function getSubagentDepth(sessionKey) {
	const raw = normalizeOptionalLowercaseString(sessionKey);
	if (!raw) return 0;
	return raw.split(":subagent:").length - 1;
}
function isAcpSessionKey(sessionKey) {
	const raw = normalizeOptionalString(sessionKey);
	if (!raw) return false;
	if (normalizeLowercaseStringOrEmpty(raw).startsWith("acp:")) return true;
	return normalizeOptionalLowercaseString(parseAgentSessionKey(raw)?.rest)?.startsWith("acp:") === true;
}
function parseThreadSessionSuffix(sessionKey) {
	const raw = normalizeOptionalString(sessionKey);
	if (!raw) return {
		baseSessionKey: void 0,
		threadId: void 0
	};
	const markerIndex = normalizeLowercaseStringOrEmpty(raw).lastIndexOf(":thread:");
	return {
		baseSessionKey: markerIndex === -1 ? raw : raw.slice(0, markerIndex),
		threadId: normalizeOptionalString(markerIndex === -1 ? void 0 : raw.slice(markerIndex + 8))
	};
}
function parseRawSessionConversationRef(sessionKey) {
	const raw = normalizeOptionalString(sessionKey);
	if (!raw) return null;
	const rawParts = raw.split(":").filter(Boolean);
	const bodyStartIndex = rawParts.length >= 3 && normalizeOptionalLowercaseString(rawParts[0]) === "agent" ? 2 : 0;
	const parts = rawParts.slice(bodyStartIndex);
	if (parts.length < 3) return null;
	const channel = normalizeOptionalLowercaseString(parts[0]);
	const kind = normalizeOptionalLowercaseString(parts[1]);
	if (!channel || kind !== "group" && kind !== "channel") return null;
	const rawId = normalizeOptionalString(parts.slice(2).join(":"));
	const prefix = normalizeOptionalString(rawParts.slice(0, bodyStartIndex + 2).join(":"));
	if (!rawId || !prefix) return null;
	return {
		channel,
		kind,
		rawId,
		prefix
	};
}
//#endregion
export { isSubagentSessionKey as a, parseThreadSessionSuffix as c, isCronSessionKey as i, isAcpSessionKey as n, parseAgentSessionKey as o, isCronRunSessionKey as r, parseRawSessionConversationRef as s, getSubagentDepth as t };
