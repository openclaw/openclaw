import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { a as findGoogleChatDirectMessage } from "./api-DTaSz4ae.js";
//#region extensions/googlechat/src/targets.ts
function normalizeGoogleChatTarget(raw) {
	const trimmed = raw?.trim();
	if (!trimmed) return;
	const normalized = trimmed.replace(/^(googlechat|google-chat|gchat):/i, "").replace(/^user:(users\/)?/i, "users/").replace(/^space:(spaces\/)?/i, "spaces/");
	if (isGoogleChatUserTarget(normalized)) {
		const suffix = normalized.slice(6);
		return suffix.includes("@") ? `users/${normalizeLowercaseStringOrEmpty(suffix)}` : normalized;
	}
	if (isGoogleChatSpaceTarget(normalized)) return normalized;
	if (normalized.includes("@")) return `users/${normalizeLowercaseStringOrEmpty(normalized)}`;
	return normalized;
}
function isGoogleChatUserTarget(value) {
	return normalizeLowercaseStringOrEmpty(value).startsWith("users/");
}
function isGoogleChatSpaceTarget(value) {
	return normalizeLowercaseStringOrEmpty(value).startsWith("spaces/");
}
function stripMessageSuffix(target) {
	const index = target.indexOf("/messages/");
	if (index === -1) return target;
	return target.slice(0, index);
}
async function resolveGoogleChatOutboundSpace(params) {
	const normalized = normalizeGoogleChatTarget(params.target);
	if (!normalized) throw new Error("Missing Google Chat target.");
	const base = stripMessageSuffix(normalized);
	if (isGoogleChatSpaceTarget(base)) return base;
	if (isGoogleChatUserTarget(base)) {
		const dm = await findGoogleChatDirectMessage({
			account: params.account,
			userName: base
		});
		if (!dm?.name) throw new Error(`No Google Chat DM found for ${base}`);
		return dm.name;
	}
	return base;
}
//#endregion
export { resolveGoogleChatOutboundSpace as i, isGoogleChatUserTarget as n, normalizeGoogleChatTarget as r, isGoogleChatSpaceTarget as t };
