import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { l as normalizeE164 } from "./utils-sBTEdeml.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { i as parseChatTargetPrefixesOrThrow, o as resolveServicePrefixedChatTarget, s as resolveServicePrefixedOrChatAllowTarget, t as createAllowedChatSenderMatcher } from "./chat-target-prefixes-DKnHakTu.js";
import "./account-resolution-Dy8RKAMt.js";
import "./channel-targets-DLOcH73y.js";
//#region extensions/imessage/src/targets.ts
const CHAT_ID_PREFIXES = [
	"chat_id:",
	"chatid:",
	"chat:"
];
const CHAT_GUID_PREFIXES = [
	"chat_guid:",
	"chatguid:",
	"guid:"
];
const CHAT_IDENTIFIER_PREFIXES = [
	"chat_identifier:",
	"chatidentifier:",
	"chatident:"
];
const SERVICE_PREFIXES = [
	{
		prefix: "imessage:",
		service: "imessage"
	},
	{
		prefix: "sms:",
		service: "sms"
	},
	{
		prefix: "auto:",
		service: "auto"
	}
];
function normalizeIMessageHandle(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const lowered = normalizeLowercaseStringOrEmpty(trimmed);
	if (lowered.startsWith("imessage:")) return normalizeIMessageHandle(trimmed.slice(9));
	if (lowered.startsWith("sms:")) return normalizeIMessageHandle(trimmed.slice(4));
	if (lowered.startsWith("auto:")) return normalizeIMessageHandle(trimmed.slice(5));
	for (const prefix of CHAT_ID_PREFIXES) if (lowered.startsWith(prefix)) return `chat_id:${trimmed.slice(prefix.length).trim()}`;
	for (const prefix of CHAT_GUID_PREFIXES) if (lowered.startsWith(prefix)) return `chat_guid:${trimmed.slice(prefix.length).trim()}`;
	for (const prefix of CHAT_IDENTIFIER_PREFIXES) if (lowered.startsWith(prefix)) return `chat_identifier:${trimmed.slice(prefix.length).trim()}`;
	if (trimmed.includes("@")) return normalizeLowercaseStringOrEmpty(trimmed);
	const normalized = normalizeE164(trimmed);
	if (normalized) return normalized;
	return trimmed.replace(/\s+/g, "");
}
function parseIMessageTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("iMessage target is required");
	const lower = normalizeLowercaseStringOrEmpty(trimmed);
	const servicePrefixed = resolveServicePrefixedChatTarget({
		trimmed,
		lower,
		servicePrefixes: SERVICE_PREFIXES,
		chatIdPrefixes: CHAT_ID_PREFIXES,
		chatGuidPrefixes: CHAT_GUID_PREFIXES,
		chatIdentifierPrefixes: CHAT_IDENTIFIER_PREFIXES,
		parseTarget: parseIMessageTarget
	});
	if (servicePrefixed) return servicePrefixed;
	const chatTarget = parseChatTargetPrefixesOrThrow({
		trimmed,
		lower,
		chatIdPrefixes: CHAT_ID_PREFIXES,
		chatGuidPrefixes: CHAT_GUID_PREFIXES,
		chatIdentifierPrefixes: CHAT_IDENTIFIER_PREFIXES
	});
	if (chatTarget) return chatTarget;
	return {
		kind: "handle",
		to: trimmed,
		service: "auto"
	};
}
function looksLikeIMessageExplicitTargetId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	const lower = normalizeLowercaseStringOrEmpty(trimmed);
	if (/^(imessage:|sms:|auto:)/.test(lower)) return true;
	return CHAT_ID_PREFIXES.some((prefix) => lower.startsWith(prefix)) || CHAT_GUID_PREFIXES.some((prefix) => lower.startsWith(prefix)) || CHAT_IDENTIFIER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}
function inferIMessageTargetChatType(raw) {
	try {
		if (parseIMessageTarget(raw).kind === "handle") return "direct";
		return "group";
	} catch {
		return;
	}
}
function parseIMessageAllowTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return {
		kind: "handle",
		handle: ""
	};
	const servicePrefixed = resolveServicePrefixedOrChatAllowTarget({
		trimmed,
		lower: normalizeLowercaseStringOrEmpty(trimmed),
		servicePrefixes: SERVICE_PREFIXES,
		parseAllowTarget: parseIMessageAllowTarget,
		chatIdPrefixes: CHAT_ID_PREFIXES,
		chatGuidPrefixes: CHAT_GUID_PREFIXES,
		chatIdentifierPrefixes: CHAT_IDENTIFIER_PREFIXES
	});
	if (servicePrefixed) return servicePrefixed;
	return {
		kind: "handle",
		handle: normalizeIMessageHandle(trimmed)
	};
}
const isAllowedIMessageSenderMatcher = createAllowedChatSenderMatcher({
	normalizeSender: normalizeIMessageHandle,
	parseAllowTarget: parseIMessageAllowTarget,
	allowConversationTargets: false
});
function isAllowedIMessageSender(params) {
	return isAllowedIMessageSenderMatcher({
		...params,
		allowConversationTargets: false
	});
}
const isAllowedIMessageReplyContextSenderMatcher = createAllowedChatSenderMatcher({
	normalizeSender: normalizeIMessageHandle,
	parseAllowTarget: parseIMessageAllowTarget,
	allowConversationTargets: true
});
function isAllowedIMessageReplyContextSender(params) {
	return isAllowedIMessageReplyContextSenderMatcher(params);
}
function formatIMessageChatTarget(chatId) {
	if (!chatId || !Number.isFinite(chatId)) return "";
	return `chat_id:${chatId}`;
}
//#endregion
export { looksLikeIMessageExplicitTargetId as a, parseIMessageTarget as c, isAllowedIMessageSender as i, inferIMessageTargetChatType as n, normalizeIMessageHandle as o, isAllowedIMessageReplyContextSender as r, parseIMessageAllowTarget as s, formatIMessageChatTarget as t };
