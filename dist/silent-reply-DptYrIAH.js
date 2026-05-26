import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { a as hasReplyPayloadContent } from "./payload-BGXKFAMn.js";
import { t as parseInlineDirectives } from "./directive-tags-BJVNV8sk.js";
import { t as copyReplyPayloadMetadata } from "./reply-payload-CfCL9mne.js";
import { r as resolveImplicitCurrentMessageReplyAllowance, t as createReplyToModeFilterForChannel } from "./reply-threading-BisJAziy.js";
import "./reply-payloads-dedupe-B3__qQ3L.js";
//#region src/auto-reply/reply/reply-tags.ts
function extractReplyToTag(text, currentMessageId) {
	const result = parseInlineDirectives(text, {
		currentMessageId,
		stripAudioTag: false
	});
	return {
		cleaned: result.text,
		replyToId: result.replyToId,
		replyToCurrent: result.replyToCurrent,
		hasTag: result.hasReplyTag
	};
}
//#endregion
//#region src/auto-reply/reply/reply-payloads-base.ts
function formatBtwTextForExternalDelivery(payload) {
	const text = normalizeOptionalString(payload.text);
	if (!text) return payload.text;
	const question = normalizeOptionalString(payload.btw?.question);
	if (!question) return payload.text;
	const formatted = `BTW\nQuestion: ${question}\n\n${text}`;
	return text === formatted || text.startsWith("BTW\nQuestion:") ? text : formatted;
}
function resolveReplyThreadingForPayload(params) {
	const implicitReplyToId = normalizeOptionalString(params.implicitReplyToId);
	const currentMessageId = normalizeOptionalString(params.currentMessageId);
	const allowImplicitReplyToCurrentMessage = resolveImplicitCurrentMessageReplyAllowance(params.replyToMode, params.replyThreading);
	let resolved = params.payload.replyToId || params.payload.replyToCurrent === false || !implicitReplyToId || !allowImplicitReplyToCurrentMessage ? params.payload : copyReplyPayloadMetadata(params.payload, {
		...params.payload,
		replyToId: implicitReplyToId
	});
	if (typeof resolved.text === "string" && resolved.text.includes("[[")) {
		const { cleaned, replyToId, replyToCurrent, hasTag } = extractReplyToTag(resolved.text, currentMessageId);
		resolved = copyReplyPayloadMetadata(resolved, {
			...resolved,
			text: cleaned ? cleaned : void 0,
			replyToId: replyToId ?? resolved.replyToId,
			replyToTag: hasTag || resolved.replyToTag,
			replyToCurrent: replyToCurrent || resolved.replyToCurrent
		});
	}
	if (resolved.replyToCurrent && !resolved.replyToId && currentMessageId) resolved = copyReplyPayloadMetadata(resolved, {
		...resolved,
		replyToId: currentMessageId
	});
	return resolved;
}
function applyReplyTagsToPayload(payload, currentMessageId) {
	return resolveReplyThreadingForPayload({
		payload,
		currentMessageId
	});
}
function isRenderablePayload(payload) {
	return hasReplyPayloadContent(payload, { extraContent: payload.audioAsVoice });
}
function shouldSuppressReasoningPayload(payload) {
	return payload.isReasoning === true;
}
function applyReplyThreading(params) {
	const { payloads, replyToMode, replyToChannel, currentMessageId, replyThreading } = params;
	const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
	const implicitReplyToId = normalizeOptionalString(currentMessageId);
	return payloads.map((payload) => resolveReplyThreadingForPayload({
		payload,
		replyToMode,
		implicitReplyToId,
		currentMessageId,
		replyThreading
	})).filter(isRenderablePayload).map(applyReplyToMode);
}
//#endregion
//#region src/shared/silent-reply-policy.ts
const DEFAULT_SILENT_REPLY_POLICY = {
	direct: "disallow",
	group: "allow",
	internal: "allow"
};
const DEFAULT_SILENT_REPLY_REWRITE = {
	direct: true,
	group: false,
	internal: false
};
const SILENT_REPLY_REWRITE_TEXTS = [
	"Nothing to add right now.",
	"All quiet on my side.",
	"No extra notes from me.",
	"Standing by.",
	"No update from me on this one.",
	"Nothing further to report.",
	"I have nothing else to add.",
	"No follow-up needed from me.",
	"No additional reply from me here.",
	"No extra comment on my end.",
	"No further note from me.",
	"That is all from me for now.",
	"No added response from me.",
	"Nothing else to say here.",
	"No extra message needed from me.",
	"No additional note on this one.",
	"No further response from me.",
	"Nothing new to add from my side.",
	"No extra update from me.",
	"I have no further reply here.",
	"Nothing additional from me.",
	"No added note from my side.",
	"No more to report from me.",
	"No extra reply needed here.",
	"No further word from me.",
	"Nothing further on my end.",
	"No extra answer from me.",
	"No additional response from my side."
];
function hashSeed(seed) {
	let hash = 0;
	for (let index = 0; index < seed.length; index += 1) hash = hash * 31 + seed.charCodeAt(index) >>> 0;
	return hash;
}
function classifySilentReplyConversationType(params) {
	if (params.conversationType) return params.conversationType;
	const normalizedSessionKey = normalizeLowercaseStringOrEmpty(params.sessionKey);
	if (normalizedSessionKey.includes(":group:") || normalizedSessionKey.includes(":channel:")) return "group";
	if (normalizedSessionKey.includes(":direct:") || normalizedSessionKey.includes(":dm:")) return "direct";
	if (normalizeLowercaseStringOrEmpty(params.surface) === "webchat") return "direct";
	return "internal";
}
function resolveSilentReplyPolicyFromPolicies(params) {
	return params.surfacePolicy?.[params.conversationType] ?? params.defaultPolicy?.[params.conversationType] ?? DEFAULT_SILENT_REPLY_POLICY[params.conversationType];
}
function resolveSilentReplyRewriteFromPolicies(params) {
	return params.surfaceRewrite?.[params.conversationType] ?? params.defaultRewrite?.[params.conversationType] ?? DEFAULT_SILENT_REPLY_REWRITE[params.conversationType];
}
function resolveSilentReplyRewriteText(params) {
	return SILENT_REPLY_REWRITE_TEXTS[hashSeed(params.seed?.trim() || "silent-reply") % SILENT_REPLY_REWRITE_TEXTS.length] ?? SILENT_REPLY_REWRITE_TEXTS[0];
}
//#endregion
//#region src/config/silent-reply.ts
function resolveSilentReplyConversationContext(params) {
	const conversationType = classifySilentReplyConversationType({
		sessionKey: params.sessionKey,
		surface: params.surface,
		conversationType: params.conversationType
	});
	const normalizedSurface = normalizeLowercaseStringOrEmpty(params.surface);
	const surface = normalizedSurface ? params.cfg?.surfaces?.[normalizedSurface] : void 0;
	return {
		conversationType,
		defaultPolicy: params.cfg?.agents?.defaults?.silentReply,
		defaultRewrite: params.cfg?.agents?.defaults?.silentReplyRewrite,
		surfacePolicy: surface?.silentReply,
		surfaceRewrite: surface?.silentReplyRewrite
	};
}
function resolveSilentReplySettings(params) {
	const context = resolveSilentReplyConversationContext(params);
	return {
		policy: resolveSilentReplyPolicyFromPolicies(context),
		rewrite: resolveSilentReplyRewriteFromPolicies(context)
	};
}
function resolveSilentReplyPolicy(params) {
	return resolveSilentReplySettings(params).policy;
}
//#endregion
export { applyReplyThreading as a, shouldSuppressReasoningPayload as c, applyReplyTagsToPayload as i, resolveSilentReplySettings as n, formatBtwTextForExternalDelivery as o, resolveSilentReplyRewriteText as r, isRenderablePayload as s, resolveSilentReplyPolicy as t };
