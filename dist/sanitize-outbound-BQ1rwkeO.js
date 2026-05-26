import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { l as normalizeE164 } from "./utils-sBTEdeml.js";
import { i as stripAssistantInternalScaffolding } from "./assistant-visible-text-BoF6Ixue.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./core-kXuNbs5U.js";
import "./media-runtime-BheBFFxc.js";
import "./text-chunking-C154U6-i.js";
import "./account-resolution-Dy8RKAMt.js";
import "./status-helpers-CnvYAK73.js";
import "./channel-status-pVVcmlap.js";
import { c as parseIMessageTarget, o as normalizeIMessageHandle$1 } from "./targets-C7radLf6.js";
//#region extensions/imessage/src/normalize.ts
const SERVICE_PREFIXES = [
	"imessage:",
	"sms:",
	"auto:"
];
const CHAT_TARGET_PREFIX_RE = /^(chat_id:|chatid:|chat:|chat_guid:|chatguid:|guid:|chat_identifier:|chatidentifier:|chatident:)/i;
function looksLikeHandleOrPhoneTarget(params) {
	const trimmed = params.raw.trim();
	if (!trimmed) return false;
	if (params.prefixPattern.test(trimmed)) return true;
	if (trimmed.includes("@")) return true;
	return (params.phonePattern ?? /^\+?\d{3,}$/).test(trimmed);
}
function normalizeIMessageHandle(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const lowered = normalizeLowercaseStringOrEmpty(trimmed);
	if (lowered.startsWith("imessage:")) return normalizeIMessageHandle(trimmed.slice(9));
	if (lowered.startsWith("sms:")) return normalizeIMessageHandle(trimmed.slice(4));
	if (lowered.startsWith("auto:")) return normalizeIMessageHandle(trimmed.slice(5));
	if (CHAT_TARGET_PREFIX_RE.test(trimmed)) {
		const prefix = trimmed.match(CHAT_TARGET_PREFIX_RE)?.[0];
		if (!prefix) return "";
		const value = trimmed.slice(prefix.length).trim();
		return `${normalizeLowercaseStringOrEmpty(prefix)}${value}`;
	}
	if (trimmed.includes("@")) return normalizeLowercaseStringOrEmpty(trimmed);
	const normalized = normalizeE164(trimmed);
	if (normalized) return normalized;
	return trimmed.replace(/\s+/g, "");
}
function normalizeIMessageMessagingTarget(raw) {
	const trimmed = normalizeOptionalString(raw);
	if (!trimmed) return;
	const lower = normalizeLowercaseStringOrEmpty(trimmed);
	for (const prefix of SERVICE_PREFIXES) if (lower.startsWith(prefix)) {
		const normalizedHandle = normalizeIMessageHandle(trimmed.slice(prefix.length).trim());
		if (!normalizedHandle) return;
		if (CHAT_TARGET_PREFIX_RE.test(normalizedHandle)) return normalizedHandle;
		return `${prefix}${normalizedHandle}`;
	}
	return normalizeIMessageHandle(trimmed) || void 0;
}
function looksLikeIMessageTargetId(raw) {
	const trimmed = normalizeOptionalString(raw);
	if (!trimmed) return false;
	if (CHAT_TARGET_PREFIX_RE.test(trimmed)) return true;
	return looksLikeHandleOrPhoneTarget({
		raw: trimmed,
		prefixPattern: /^(imessage:|sms:|auto:)/i
	});
}
//#endregion
//#region extensions/imessage/src/conversation-id-core.ts
function normalizeIMessageAcpConversationId(conversationId) {
	const trimmed = conversationId.trim();
	if (!trimmed) return null;
	try {
		const parsed = parseIMessageTarget(trimmed);
		if (parsed.kind === "handle") {
			const handle = normalizeIMessageHandle$1(parsed.to);
			return handle ? { conversationId: handle } : null;
		}
		if (parsed.kind === "chat_id") return { conversationId: String(parsed.chatId) };
		if (parsed.kind === "chat_guid") return { conversationId: parsed.chatGuid };
		return { conversationId: parsed.chatIdentifier };
	} catch {
		const handle = normalizeIMessageHandle$1(trimmed);
		return handle ? { conversationId: handle } : null;
	}
}
function matchIMessageAcpConversation(params) {
	const binding = normalizeIMessageAcpConversationId(params.bindingConversationId);
	const conversation = normalizeIMessageAcpConversationId(params.conversationId);
	if (!binding || !conversation) return null;
	if (binding.conversationId !== conversation.conversationId) return null;
	return {
		conversationId: conversation.conversationId,
		matchPriority: 2
	};
}
function resolveIMessageConversationIdFromTarget(target) {
	return normalizeIMessageAcpConversationId(target)?.conversationId;
}
//#endregion
//#region extensions/imessage/src/conversation-id.ts
function resolveIMessageInboundConversationId(params) {
	if (params.isGroup) return params.chatId != null && Number.isFinite(params.chatId) ? String(params.chatId) : void 0;
	return normalizeIMessageHandle$1(params.sender) || void 0;
}
//#endregion
//#region extensions/imessage/src/monitor/sanitize-outbound.ts
/**
* Patterns that indicate assistant-internal metadata leaked into text.
* These must never reach a user-facing channel.
*/
const INTERNAL_SEPARATOR_RE = /(?:#\+){2,}#?/g;
const ASSISTANT_ROLE_MARKER_RE = /\bassistant\s+to\s*=\s*\w+/gi;
const ROLE_TURN_MARKER_RE = /\b(?:user|system|assistant)\s*:\s*$/gm;
/**
* Strip all assistant-internal scaffolding from outbound text before delivery.
* Applies reasoning/thinking tag removal, memory tag removal, and
* model-specific internal separator stripping.
*/
function sanitizeOutboundText(text) {
	if (!text) return text;
	let cleaned = stripAssistantInternalScaffolding(text);
	cleaned = cleaned.replace(INTERNAL_SEPARATOR_RE, "");
	cleaned = cleaned.replace(ASSISTANT_ROLE_MARKER_RE, "");
	cleaned = cleaned.replace(ROLE_TURN_MARKER_RE, "");
	cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
	return cleaned;
}
//#endregion
export { resolveIMessageConversationIdFromTarget as a, normalizeIMessageAcpConversationId as i, resolveIMessageInboundConversationId as n, looksLikeIMessageTargetId as o, matchIMessageAcpConversation as r, normalizeIMessageMessagingTarget as s, sanitizeOutboundText as t };
