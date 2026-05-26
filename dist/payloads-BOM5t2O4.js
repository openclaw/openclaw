import { r as isSilentReplyPayloadText } from "./tokens-CFv3Qu_v.js";
import { t as parseInlineDirectives } from "./directive-tags-CClLEtM7.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-DMPQsrQC.js";
import { a as hasReplyPayloadContent, c as normalizeInteractiveReply, l as normalizeMessagePresentation, n as hasMessagePresentationBlocks, r as hasReplyChannelData, t as hasInteractiveReplyBlocks } from "./payload-BDV15CYA.js";
import { r as splitMediaFromOutput } from "./parse-Hq4glz65.js";
import { a as shouldSuppressReasoningPayload, i as isRenderablePayload, r as formatBtwTextForExternalDelivery } from "./reply-payloads-MDazU9oj.js";
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
//#region src/shared/text/citation-control-markers.ts
const UNSUPPORTED_CITATION_CONTROL_MARKER_RE = /cite(?:[^]*)?/g;
const TRAILING_UNSUPPORTED_CITATION_CONTROL_MARKER_RE = /[ \t]*cite(?:[^]*)?(?=\r?\n|$)/g;
function stripUnsupportedCitationControlMarkers(text) {
	return text.replace(TRAILING_UNSUPPORTED_CITATION_CONTROL_MARKER_RE, "").replace(UNSUPPORTED_CITATION_CONTROL_MARKER_RE, "");
}
//#endregion
//#region src/infra/outbound/payloads.ts
function collectPresentationMirrorText(presentation) {
	if (!presentation) return [];
	const lines = [];
	if (presentation.title?.trim()) lines.push(presentation.title.trim());
	for (const block of presentation.blocks) {
		if ((block.type === "text" || block.type === "context") && block.text.trim()) {
			lines.push(block.text.trim());
			continue;
		}
		if (block.type === "buttons") {
			for (const button of block.buttons) if (button.label.trim()) lines.push(button.label.trim());
			continue;
		}
		if (block.type === "select") {
			if (block.placeholder?.trim()) lines.push(block.placeholder.trim());
			for (const option of block.options) if (option.label.trim()) lines.push(option.label.trim());
		}
	}
	return lines;
}
function collectInteractiveMirrorText(interactive) {
	if (!interactive) return [];
	const lines = [];
	for (const block of interactive.blocks) {
		if (block.type === "text" && block.text.trim()) {
			lines.push(block.text.trim());
			continue;
		}
		if (block.type === "buttons") {
			for (const button of block.buttons) if (button.label.trim()) lines.push(button.label.trim());
			continue;
		}
		if (block.type === "select") {
			if (block.placeholder?.trim()) lines.push(block.placeholder.trim());
			for (const option of block.options) if (option.label.trim()) lines.push(option.label.trim());
		}
	}
	return lines;
}
function resolveOutboundMirrorText(entry) {
	const text = entry.parts.text.trim() ? entry.parts.text : entry.payload.text;
	if (text?.trim()) return text;
	const presentation = normalizeMessagePresentation(entry.payload.presentation);
	const interactive = normalizeInteractiveReply(entry.payload.interactive);
	return [...collectPresentationMirrorText(presentation), ...collectInteractiveMirrorText(interactive)].join("\n");
}
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
	const strippedText = stripUnsupportedCitationControlMarkers(parsed.text ?? "");
	const strippedParsed = strippedText === (parsed.text ?? "") ? parsed : parseReplyDirectives(strippedText);
	const parsedText = strippedParsed.text ?? "";
	if (isSuppressedRelayStatusText(parsedText) && mergedMedia.length === 0) return null;
	const isSilent = strippedParsed.isSilent && mergedMedia.length === 0;
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
		text: plan.map(resolveOutboundMirrorText).filter((text) => Boolean(text)).join("\n"),
		mediaUrls: plan.flatMap((entry) => entry.parts.mediaUrls)
	};
}
function summarizeOutboundPayloadForTransport(payload) {
	const parts = resolveSendableOutboundReplyParts(payload);
	const text = stripUnsupportedCitationControlMarkers(parts.text);
	const strippedSpokenText = typeof payload.spokenText === "string" ? stripUnsupportedCitationControlMarkers(payload.spokenText) : void 0;
	const spokenText = strippedSpokenText?.trim() ? strippedSpokenText : void 0;
	return {
		text,
		mediaUrls: parts.mediaUrls,
		audioAsVoice: payload.audioAsVoice === true ? true : void 0,
		presentation: payload.presentation,
		delivery: payload.delivery,
		interactive: payload.interactive,
		channelData: payload.channelData,
		...text || !spokenText ? {} : { hookContent: spokenText }
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
export { projectOutboundPayloadPlanForDelivery as a, projectOutboundPayloadPlanForOutbound as c, parseReplyDirectives as d, normalizeReplyPayloadsForDelivery as i, summarizeOutboundPayloadForTransport as l, formatOutboundPayloadLog as n, projectOutboundPayloadPlanForJson as o, normalizeOutboundPayloadsForJson as r, projectOutboundPayloadPlanForMirror as s, createOutboundPayloadPlan as t, stripUnsupportedCitationControlMarkers as u };
