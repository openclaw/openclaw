import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
//#region src/sessions/session-chat-type-shared.ts
function deriveBuiltInLegacySessionChatType(scopedSessionKey) {
	if (/^group:[^:]+$/.test(scopedSessionKey)) return "group";
	if (/^(?:whatsapp:)?[^:]+@g\.us$/.test(scopedSessionKey)) return "group";
	if (/^discord:(?:[^:]+:)?guild-[^:]+:channel-[^:]+$/.test(scopedSessionKey)) return "channel";
}
function deriveSessionChatTypeFromScopedKey(scopedSessionKey, deriveLegacySessionChatTypes = []) {
	const tokens = new Set(scopedSessionKey.split(":").filter(Boolean));
	if (tokens.has("group")) return "group";
	if (tokens.has("channel")) return "channel";
	if (tokens.has("direct") || tokens.has("dm")) return "direct";
	const builtInLegacy = deriveBuiltInLegacySessionChatType(scopedSessionKey);
	if (builtInLegacy) return builtInLegacy;
	for (const deriveLegacySessionChatType of deriveLegacySessionChatTypes) {
		const derived = deriveLegacySessionChatType(scopedSessionKey);
		if (derived) return derived;
	}
	return "unknown";
}
/**
* Best-effort chat-type extraction from session keys across canonical and legacy formats.
*/
function deriveSessionChatTypeFromKey(sessionKey, deriveLegacySessionChatTypes = []) {
	const raw = normalizeLowercaseStringOrEmpty(sessionKey);
	if (!raw) return "unknown";
	return deriveSessionChatTypeFromScopedKey(parseAgentSessionKey(raw)?.rest ?? raw, deriveLegacySessionChatTypes);
}
//#endregion
export { deriveSessionChatTypeFromKey as t };
