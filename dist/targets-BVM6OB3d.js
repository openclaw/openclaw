import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
//#region extensions/feishu/src/targets.ts
const CHAT_ID_PREFIX = "oc_";
const OPEN_ID_PREFIX = "ou_";
const USER_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
function stripProviderPrefix(raw) {
	return raw.replace(/^(feishu|lark):/i, "").trim();
}
function detectIdType(id) {
	const trimmed = id.trim();
	if (trimmed.startsWith(CHAT_ID_PREFIX)) return "chat_id";
	if (trimmed.startsWith(OPEN_ID_PREFIX)) return "open_id";
	if (USER_ID_REGEX.test(trimmed)) return "user_id";
	return null;
}
function normalizeFeishuTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const withoutProvider = stripProviderPrefix(trimmed);
	const lowered = normalizeLowercaseStringOrEmpty(withoutProvider);
	if (lowered.startsWith("chat:")) return withoutProvider.slice(5).trim() || null;
	if (lowered.startsWith("group:")) return withoutProvider.slice(6).trim() || null;
	if (lowered.startsWith("channel:")) return withoutProvider.slice(8).trim() || null;
	if (lowered.startsWith("user:")) return withoutProvider.slice(5).trim() || null;
	if (lowered.startsWith("dm:")) return withoutProvider.slice(3).trim() || null;
	if (lowered.startsWith("open_id:")) return withoutProvider.slice(8).trim() || null;
	return withoutProvider;
}
function resolveReceiveIdType(id) {
	const trimmed = id.trim();
	const lowered = normalizeLowercaseStringOrEmpty(trimmed);
	if (lowered.startsWith("chat:") || lowered.startsWith("group:") || lowered.startsWith("channel:")) return "chat_id";
	if (lowered.startsWith("open_id:")) return "open_id";
	if (lowered.startsWith("user:") || lowered.startsWith("dm:")) return trimmed.replace(/^(user|dm):/i, "").trim().startsWith(OPEN_ID_PREFIX) ? "open_id" : "user_id";
	if (trimmed.startsWith(CHAT_ID_PREFIX)) return "chat_id";
	if (trimmed.startsWith(OPEN_ID_PREFIX)) return "open_id";
	return "user_id";
}
function looksLikeFeishuId(raw) {
	const trimmed = stripProviderPrefix(raw.trim());
	if (!trimmed) return false;
	if (/^(chat|group|channel|user|dm|open_id):/i.test(trimmed)) return true;
	if (trimmed.startsWith(CHAT_ID_PREFIX)) return true;
	if (trimmed.startsWith(OPEN_ID_PREFIX)) return true;
	return false;
}
//#endregion
export { resolveReceiveIdType as i, looksLikeFeishuId as n, normalizeFeishuTarget as r, detectIdType as t };
