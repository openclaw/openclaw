import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import "./string-coerce-runtime-Yq8raY7h.js";
//#region extensions/whatsapp/src/session-contract.ts
function extractLegacyWhatsAppGroupId(key) {
	const trimmed = key.trim();
	if (!trimmed) return null;
	const lower = normalizeLowercaseStringOrEmpty(trimmed);
	if (trimmed.startsWith("group:")) {
		const id = trimmed.slice(6).trim();
		return normalizeLowercaseStringOrEmpty(id).includes("@g.us") ? id : null;
	}
	if (!lower.includes("@g.us")) return null;
	if (!trimmed.includes(":")) return trimmed;
	if (lower.startsWith("whatsapp:") && !trimmed.includes(":group:")) return trimmed.slice(9).trim().replace(/^group:/i, "").trim() || null;
	return null;
}
function isLegacyGroupSessionKey(key) {
	return extractLegacyWhatsAppGroupId(key) !== null;
}
function deriveLegacySessionChatType(key) {
	return isLegacyGroupSessionKey(key) ? "group" : void 0;
}
function canonicalizeLegacySessionKey(params) {
	const legacyGroupId = extractLegacyWhatsAppGroupId(params.key);
	return legacyGroupId ? `agent:${normalizeLowercaseStringOrEmpty(params.agentId)}:whatsapp:group:${normalizeLowercaseStringOrEmpty(legacyGroupId)}` : null;
}
//#endregion
export { deriveLegacySessionChatType as n, isLegacyGroupSessionKey as r, canonicalizeLegacySessionKey as t };
