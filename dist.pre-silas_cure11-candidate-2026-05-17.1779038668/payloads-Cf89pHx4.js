import { t as parseInlineDirectives } from "./directive-tags-Plnuh5up.js";
import { r as isSilentReplyPayloadText } from "./tokens-CF0uy0oR.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-Cx3id63H.js";
import { a as hasReplyPayloadContent, n as hasMessagePresentationBlocks, r as hasReplyChannelData, t as hasInteractiveReplyBlocks } from "./payload-MntxVKMU.js";
import { r as splitMediaFromOutput } from "./parse-rjGchbFk.js";
import { a as shouldSuppressReasoningPayload, i as isRenderablePayload, r as formatBtwTextForExternalDelivery } from "./reply-payloads-CcKD9s1x.js";
//#region src/auto-reply/reply/reply-directives.ts
function parseReplyDirectives(raw, options = {}) {
	const split = splitMediaFromOutput(raw, { extractMarkdownImages: options.extractMarkdownImages });
	let text = split.text ?? "";
	const replyParsed = parseInlineDirectives(text, {
		currentMessageId: options.currentMessageId,
		stripAudioTag: false,
		stripReplyTags: true
	});
	if (replyParsed.hasReplyTag) text = replyParsed.text;
	const silentToken = options.silentToken ?? "NO_REPLY";
	const isSilent = isSilentReplyPayloadText(text, silentToken);
	if (isSilent) text = "";
	return {
		text,
		mediaUrls: split.mediaUrls,
		mediaUrl: split.mediaUrl,
		replyToId: replyParsed.replyToId,
		replyToCurrent: replyParsed.replyToCurrent || void 0,
		replyToTag: replyParsed.hasReplyTag,
		audioAsVoice: split.audioAsVoice,
		isSilent
	};
}
//#endregion
//#region src/infra/outbound/payloads.ts
function isSuppressedRelayStatusText(text) {
	const normalized = text.trim();
	if (!normalized) return false;
	if (/^no channel reply\.?$/i.test(normalized)) return true;
	if (/^replied in-thread\.?$/i.test(normalized)) return true;
	if (/^replied in #[-\w]+\.?$/i.test(normalized)) return true;
	if (/^updated\s+\[[^\]]*wiki\/[^\]]+\](?:\([^)]+\))?(?:\s+with\b[\s\S]*)?(?:\.\s*)?(?:no channel reply\.?)?$/i.test(normalized)) return true;
	return false;
}
function mergeMediaUrls(...lists) {
	const seen = /* @__PURE__ */ new Set();
	const merged = [];
	for (const list of lists) {
		if (!list) continue;
		for (const entry of list) {
			const trimmed = entry?.trim();
			if (!trimmed) continue;
			if (seen.has(trimmed)) continue;
			seen.add(trimmed);
			merged.push(trimmed);
		}
	}
	return merged;
}
function createOutboundPayloadPlanEntry(payload, context = {}) {
	if (shouldSuppressReasoningPayload(payload)) return null;
	const parsed = parseReplyDirectives(payload.text ?? "", { extractMarkdownImages: context.extractMarkdownImages });
	const explicitMediaUrls = payload.mediaUrls ?? parsed.mediaUrls;
	const explicitMediaUrl = payload.mediaUrl ?? parsed.mediaUrl;
	const mergedMedia = mergeMediaUrls(explicitMediaUrls, explicitMediaUrl ? [explicitMediaUrl] : void 0);
	const parsedText = parsed.text ?? "";
	if (isSuppressedRelayStatusText(parsedText) && mergedMedia.length === 0) return null;
	const isSilent = parsed.isSilent && mergedMedia.length === 0;
	const resolvedMediaUrl = (explicitMediaUrls?.length ?? 0) > 1 ? void 0 : explicitMediaUrl;
	const normalizedPayload = {
		...payload,
		text: formatBtwTextForExternalDelivery({
			...payload,
			text: parsedText
		}) ?? "",
		mediaUrls: mergedMedia.length ? mergedMedia : void 0,
		mediaUrl: resolvedMediaUrl,
		replyToId: payload.replyToId ?? parsed.replyToId,
		replyToTag: payload.replyToTag || parsed.replyToTag,
		replyToCurrent: payload.replyToCurrent || parsed.replyToCurrent,
		audioAsVoice: Boolean(payload.audioAsVoice || parsed.audioAsVoice)
	};
	if (!isRenderablePayload(normalizedPayload) && !isSilent) return null;
	const hasChannelData = hasReplyChannelData(normalizedPayload.channelData);
	return {
		payload: normalizedPayload,
		hasPresentation: hasMessagePresentationBlocks(normalizedPayload.presentation),
		hasInteractive: hasInteractiveReplyBlocks(normalizedPayload.interactive),
		hasChannelData,
		isSilent
	};
}
function createOutboundPayloadPlan(payloads, context = {}) {
	const prepared = [];
	for (const [sourceIndex, payload] of payloads.entries()) {
		const entry = createOutboundPayloadPlanEntry(payload, { extractMarkdownImages: context.extractMarkdownImages });
		if (!entry) continue;
		prepared.push({
			...entry,
			sourceIndex
		});
	}
	const plan = [];
	for (const entry of prepared) if (!entry.isSilent) {
		plan.push({
			sourceIndex: entry.sourceIndex,
			payload: entry.payload,
			parts: resolveSendableOutboundReplyParts(entry.payload),
			hasPresentation: entry.hasPresentation,
			hasInteractive: entry.hasInteractive,
			hasChannelData: entry.hasChannelData
		});
		continue;
	}
	return plan;
}
function projectOutboundPayloadPlanForDelivery(plan) {
	return plan.map((entry) => entry.payload);
}
function projectOutboundPayloadPlanForOutbound(plan) {
	const normalizedPayloads = [];
	for (const entry of plan) {
		const payload = entry.payload;
		const text = entry.parts.text;
		if (!hasReplyPayloadContent({
			...payload,
			text,
			mediaUrls: entry.parts.mediaUrls
		}, { hasChannelData: entry.hasChannelData })) continue;
		normalizedPayloads.push({
			text,
			mediaUrls: entry.parts.mediaUrls,
			audioAsVoice: payload.audioAsVoice === true ? true : void 0,
			...entry.hasPresentation ? { presentation: payload.presentation } : {},
			...payload.delivery ? { delivery: payload.delivery } : {},
			...entry.hasInteractive ? { interactive: payload.interactive } : {},
			...entry.hasChannelData ? { channelData: payload.channelData } : {}
		});
	}
	return normalizedPayloads;
}
function projectOutboundPayloadPlanForJson(plan) {
	const normalized = [];
	for (const entry of plan) {
		const payload = entry.payload;
		normalized.push({
			text: entry.parts.text,
			mediaUrl: payload.mediaUrl ?? null,
			mediaUrls: entry.parts.mediaUrls.length ? entry.parts.mediaUrls : void 0,
			audioAsVoice: payload.audioAsVoice === true ? true : void 0,
			presentation: payload.presentation,
			delivery: payload.delivery,
			interactive: payload.interactive,
			channelData: payload.channelData
		});
	}
	return normalized;
}
function projectOutboundPayloadPlanForMirror(plan) {
	return {
		text: plan.map((entry) => entry.payload.text).filter((text) => Boolean(text)).join("\n"),
		mediaUrls: plan.flatMap((entry) => entry.parts.mediaUrls)
	};
}
function summarizeOutboundPayloadForTransport(payload) {
	const parts = resolveSendableOutboundReplyParts(payload);
	const spokenText = payload.spokenText?.trim() ? payload.spokenText : void 0;
	return {
		text: parts.text,
		mediaUrls: parts.mediaUrls,
		audioAsVoice: payload.audioAsVoice === true ? true : void 0,
		presentation: payload.presentation,
		delivery: payload.delivery,
		interactive: payload.interactive,
		channelData: payload.channelData,
		...parts.text || !spokenText ? {} : { hookContent: spokenText }
	};
}
function normalizeReplyPayloadsForDelivery(payloads) {
	return projectOutboundPayloadPlanForDelivery(createOutboundPayloadPlan(payloads));
}
function normalizeOutboundPayloadsForJson(payloads) {
	return projectOutboundPayloadPlanForJson(createOutboundPayloadPlan(payloads));
}
function formatOutboundPayloadLog(payload) {
	const lines = [];
	if (payload.text) lines.push(payload.text.trimEnd());
	for (const url of payload.mediaUrls) lines.push(`MEDIA:${url}`);
	return lines.join("\n");
}
//#endregion
export { projectOutboundPayloadPlanForDelivery as a, projectOutboundPayloadPlanForOutbound as c, normalizeReplyPayloadsForDelivery as i, summarizeOutboundPayloadForTransport as l, formatOutboundPayloadLog as n, projectOutboundPayloadPlanForJson as o, normalizeOutboundPayloadsForJson as r, projectOutboundPayloadPlanForMirror as s, createOutboundPayloadPlan as t, parseReplyDirectives as u };
