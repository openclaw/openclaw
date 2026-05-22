import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { n as emitDiagnosticEvent } from "./diagnostic-events-Cq5CLuNc.js";
import { t as createSubsystemLogger } from "./subsystem-DNg_cpPU.js";
import { l as fireAndForgetHook, t as getGlobalHookRunner } from "./hook-runner-global-C28f80Kh.js";
import { m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-Dhu5xFAu.js";
import { a as resolveMirroredTranscriptText } from "./transcript-Dlrr7XVN.js";
import { t as parseInlineDirectives } from "./directive-tags-c3QUlefa.js";
import { r as isSilentReplyPayloadText } from "./tokens-qGU895-2.js";
import { r as splitMediaFromOutput } from "./parse-wbvXw1Je.js";
import { C as createReplyToDeliveryPolicy, m as resolveSendableOutboundReplyParts } from "./reply-payload-4x-lSxGs.js";
import { t as diagnosticErrorCategory } from "./diagnostic-error-metadata-DlYfg0K8.js";
import { t as resolveAgentScopedOutboundMediaAccess } from "./read-capability-ucJFH_LS.js";
import { a as hasReplyPayloadContent, c as normalizeMessagePresentation, n as hasMessagePresentationBlocks, r as hasReplyChannelData, t as hasInteractiveReplyBlocks, u as renderMessagePresentationFallbackText } from "./payload-DRvk5ABz.js";
import { c as resolveTextChunkLimit, i as chunkMarkdownTextWithMode, n as chunkByParagraph, s as resolveChunkMode } from "./chunk-Bkxjj_pw.js";
import { t as loadChannelOutboundAdapter } from "./load-C3RRd7u5.js";
import { a as toInternalMessageSentContext, d as toPluginMessageSentEvent, l as toPluginMessageContext, t as buildCanonicalSentMessageHookContext } from "./message-hook-mappers-ukSoIU3x.js";
import { c as enqueueDelivery, o as withActiveDeliveryClaim, s as ackDelivery, u as failDelivery } from "./delivery-queue-DYPh9kvw.js";
import { c as shouldSuppressReasoningPayload, n as resolveSilentReplySettings, o as formatBtwTextForExternalDelivery, r as resolveSilentReplyRewriteText, s as isRenderablePayload } from "./silent-reply-BdKzZalV.js";
import { n as resolvePendingSpawnedChildren } from "./pending-spawn-query-Tn-DGc8s.js";
import { n as stripInternalRuntimeScaffolding } from "./sanitize-text-bhB4XXCV.js";
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
//#region src/infra/outbound/abort.ts
/**
* Utility for checking AbortSignal state and throwing a standard AbortError.
*/
/**
* Throws an AbortError if the given signal has been aborted.
* Use at async checkpoints to support cancellation.
*/
function throwIfAborted(abortSignal) {
	if (abortSignal?.aborted) {
		const err = /* @__PURE__ */ new Error("Operation aborted");
		err.name = "AbortError";
		throw err;
	}
}
//#endregion
//#region src/infra/outbound/message-plan.ts
function withPlannedReplyTo(overrides, consumeReplyTo) {
	return consumeReplyTo ? consumeReplyTo({ ...overrides }) : { ...overrides };
}
function chunkTextForPlan(params) {
	return params.formatting ? params.chunker(params.text, params.limit, { formatting: params.formatting }) : params.chunker(params.text, params.limit);
}
function planOutboundTextMessageUnits(params) {
	const planTextUnit = (text) => ({
		kind: "text",
		text,
		overrides: withPlannedReplyTo(params.overrides, params.consumeReplyTo)
	});
	if (!params.chunker || params.textLimit === void 0) return [planTextUnit(params.text)];
	if (params.chunkMode === "newline") {
		const blockChunks = (params.chunkerMode ?? "text") === "markdown" ? chunkMarkdownTextWithMode(params.text, params.textLimit, "newline") : chunkByParagraph(params.text, params.textLimit);
		if (!blockChunks.length && params.text) blockChunks.push(params.text);
		const units = [];
		for (const blockChunk of blockChunks) {
			const chunks = chunkTextForPlan({
				text: blockChunk,
				limit: params.textLimit,
				chunker: params.chunker,
				formatting: params.formatting
			});
			if (!chunks.length && blockChunk) chunks.push(blockChunk);
			for (const chunk of chunks) units.push(planTextUnit(chunk));
		}
		return units;
	}
	return chunkTextForPlan({
		text: params.text,
		limit: params.textLimit,
		chunker: params.chunker,
		formatting: params.formatting
	}).map(planTextUnit);
}
function planOutboundMediaMessageUnits(params) {
	return params.mediaUrls.map((mediaUrl, index) => ({
		kind: "media",
		mediaUrl,
		...index === 0 ? { caption: params.caption } : {},
		overrides: withPlannedReplyTo(params.overrides, params.consumeReplyTo)
	}));
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
	const resolvedSilentReplySettings = resolveSilentReplySettings({
		cfg: context.cfg,
		sessionKey: context.sessionKey,
		surface: context.surface,
		conversationType: context.conversationType
	});
	const hasPendingSpawnedChildren = context.hasPendingSpawnedChildren ?? resolvePendingSpawnedChildren(context.sessionKey);
	const prepared = [];
	for (const payload of payloads) {
		const entry = createOutboundPayloadPlanEntry(payload, { extractMarkdownImages: context.extractMarkdownImages });
		if (!entry) continue;
		prepared.push(entry);
	}
	const hasVisibleNonSilentContent = prepared.some((entry) => {
		if (entry.isSilent) return false;
		const parts = resolveSendableOutboundReplyParts(entry.payload);
		return hasReplyPayloadContent({
			...entry.payload,
			text: parts.text,
			mediaUrls: parts.mediaUrls
		}, { hasChannelData: entry.hasChannelData });
	});
	const plan = [];
	for (const entry of prepared) {
		if (!entry.isSilent) {
			plan.push({
				payload: entry.payload,
				parts: resolveSendableOutboundReplyParts(entry.payload),
				hasPresentation: entry.hasPresentation,
				hasInteractive: entry.hasInteractive,
				hasChannelData: entry.hasChannelData
			});
			continue;
		}
		if (hasVisibleNonSilentContent || resolvedSilentReplySettings.policy === "allow" || hasPendingSpawnedChildren) continue;
		if (!resolvedSilentReplySettings.rewrite) {
			const visibleSilentPayload = {
				...entry.payload,
				text: entry.payload.text?.trim() || "NO_REPLY"
			};
			if (!isRenderablePayload(visibleSilentPayload)) continue;
			plan.push({
				payload: visibleSilentPayload,
				parts: resolveSendableOutboundReplyParts(visibleSilentPayload),
				hasPresentation: entry.hasPresentation,
				hasInteractive: entry.hasInteractive,
				hasChannelData: entry.hasChannelData
			});
			continue;
		}
		const visibleSilentPayload = {
			...entry.payload,
			text: resolveSilentReplyRewriteText({ seed: `${context.sessionKey ?? context.surface ?? "silent-reply"}:${entry.payload.text ?? ""}` })
		};
		if (!isRenderablePayload(visibleSilentPayload)) continue;
		plan.push({
			payload: visibleSilentPayload,
			parts: resolveSendableOutboundReplyParts(visibleSilentPayload),
			hasPresentation: entry.hasPresentation,
			hasInteractive: entry.hasInteractive,
			hasChannelData: entry.hasChannelData
		});
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
//#region src/infra/outbound/deliver.ts
const log = createSubsystemLogger("outbound/deliver");
let transcriptRuntimePromise;
async function loadTranscriptRuntime() {
	transcriptRuntimePromise ??= import("./transcript.runtime.js");
	return await transcriptRuntimePromise;
}
let channelBootstrapRuntimePromise;
async function loadChannelBootstrapRuntime() {
	channelBootstrapRuntimePromise ??= import("./channel-bootstrap.runtime-CQmpbPAA.js");
	return await channelBootstrapRuntimePromise;
}
async function resolveChannelOutboundDirectiveOptions(params) {
	let outbound = await loadChannelOutboundAdapter(params.channel);
	if (!outbound) {
		const { bootstrapOutboundChannelPlugin } = await loadChannelBootstrapRuntime();
		bootstrapOutboundChannelPlugin({
			channel: params.channel,
			cfg: params.cfg
		});
		outbound = await loadChannelOutboundAdapter(params.channel);
	}
	return { extractMarkdownImages: outbound?.extractMarkdownImages === true ? true : void 0 };
}
async function createChannelHandler(params) {
	let outbound = await loadChannelOutboundAdapter(params.channel);
	if (!outbound) {
		const { bootstrapOutboundChannelPlugin } = await loadChannelBootstrapRuntime();
		bootstrapOutboundChannelPlugin({
			channel: params.channel,
			cfg: params.cfg
		});
		outbound = await loadChannelOutboundAdapter(params.channel);
	}
	const handler = createPluginHandler({
		...params,
		outbound
	});
	if (!handler) throw new Error(`Outbound not configured for channel: ${params.channel}`);
	return handler;
}
function createPluginHandler(params) {
	const outbound = params.outbound;
	if (!outbound?.sendText) return null;
	const baseCtx = createChannelOutboundContextBase(params);
	const sendText = outbound.sendText;
	const sendMedia = outbound.sendMedia;
	const chunker = outbound.chunker ?? null;
	const chunkerMode = outbound.chunkerMode;
	const resolveCtx = (overrides) => ({
		...baseCtx,
		replyToId: overrides && "replyToId" in overrides ? overrides.replyToId : baseCtx.replyToId,
		replyToIdSource: overrides && "replyToIdSource" in overrides ? overrides.replyToIdSource : baseCtx.replyToIdSource,
		threadId: overrides && "threadId" in overrides ? overrides.threadId : baseCtx.threadId,
		audioAsVoice: overrides?.audioAsVoice
	});
	const buildTargetRef = (overrides) => ({
		channel: params.channel,
		to: params.to,
		accountId: params.accountId ?? void 0,
		threadId: overrides?.threadId ?? baseCtx.threadId
	});
	return {
		chunker,
		chunkerMode,
		textChunkLimit: outbound.textChunkLimit,
		supportsMedia: Boolean(sendMedia),
		sanitizeText: outbound.sanitizeText ? (payload) => outbound.sanitizeText({
			text: payload.text ?? "",
			payload
		}) : void 0,
		normalizePayload: outbound.normalizePayload ? (payload) => outbound.normalizePayload({ payload }) : void 0,
		sendTextOnlyErrorPayloads: outbound.sendTextOnlyErrorPayloads === true,
		renderPresentation: outbound.renderPresentation ? async (payload) => {
			const presentation = normalizeMessagePresentation(payload.presentation);
			if (!presentation) return payload;
			const ctx = {
				...resolveCtx({
					replyToId: payload.replyToId ?? baseCtx.replyToId,
					threadId: baseCtx.threadId,
					audioAsVoice: payload.audioAsVoice
				}),
				text: payload.text ?? "",
				mediaUrl: payload.mediaUrl,
				payload
			};
			return await outbound.renderPresentation({
				payload,
				presentation,
				ctx
			});
		} : void 0,
		pinDeliveredMessage: outbound.pinDeliveredMessage ? async ({ target, messageId, pin }) => outbound.pinDeliveredMessage({
			cfg: params.cfg,
			target,
			messageId,
			pin
		}) : void 0,
		afterDeliverPayload: outbound.afterDeliverPayload ? async ({ target, payload, results }) => outbound.afterDeliverPayload({
			cfg: params.cfg,
			target,
			payload,
			results
		}) : void 0,
		shouldSkipPlainTextSanitization: outbound.shouldSkipPlainTextSanitization ? (payload) => outbound.shouldSkipPlainTextSanitization({ payload }) : void 0,
		resolveEffectiveTextChunkLimit: outbound.resolveEffectiveTextChunkLimit ? (fallbackLimit) => outbound.resolveEffectiveTextChunkLimit({
			cfg: params.cfg,
			accountId: params.accountId ?? void 0,
			fallbackLimit
		}) : void 0,
		sendPayload: outbound.sendPayload ? async (payload, overrides) => outbound.sendPayload({
			...resolveCtx(overrides),
			text: payload.text ?? "",
			mediaUrl: payload.mediaUrl,
			payload
		}) : void 0,
		sendFormattedText: outbound.sendFormattedText ? async (text, overrides) => outbound.sendFormattedText({
			...resolveCtx(overrides),
			text
		}) : void 0,
		sendFormattedMedia: outbound.sendFormattedMedia ? async (caption, mediaUrl, overrides) => outbound.sendFormattedMedia({
			...resolveCtx(overrides),
			text: caption,
			mediaUrl
		}) : void 0,
		sendText: async (text, overrides) => sendText({
			...resolveCtx(overrides),
			text
		}),
		buildTargetRef,
		sendMedia: async (caption, mediaUrl, overrides) => {
			if (sendMedia) return sendMedia({
				...resolveCtx(overrides),
				text: caption,
				mediaUrl
			});
			return sendText({
				...resolveCtx(overrides),
				text: caption
			});
		}
	};
}
function createChannelOutboundContextBase(params) {
	return {
		cfg: params.cfg,
		to: params.to,
		accountId: params.accountId,
		replyToId: params.replyToId,
		replyToMode: params.replyToMode,
		formatting: params.formatting,
		threadId: params.threadId,
		identity: params.identity,
		gifPlayback: params.gifPlayback,
		forceDocument: params.forceDocument,
		deps: params.deps,
		silent: params.silent,
		mediaAccess: params.mediaAccess,
		mediaLocalRoots: params.mediaAccess?.localRoots,
		mediaReadFile: params.mediaAccess?.readFile,
		gatewayClientScopes: params.gatewayClientScopes
	};
}
const isAbortError = (err) => err instanceof Error && err.name === "AbortError";
function collectPayloadMediaSources(plan) {
	return plan.flatMap((entry) => entry.parts.mediaUrls);
}
function sessionKeyForDeliveryDiagnostics(params) {
	return params.mirror?.sessionKey ?? params.session?.key ?? params.session?.policyKey;
}
function deliveryKindForPayload(payload, payloadSummary) {
	if (payloadSummary.mediaUrls.length > 0 || payload.mediaUrl || payload.mediaUrls?.length) return "media";
	if (payload.presentation || payload.interactive || payload.channelData || payload.audioAsVoice) return "other";
	return "text";
}
function emitMessageDeliveryStarted(params) {
	emitDiagnosticEvent({
		type: "message.delivery.started",
		channel: params.channel,
		deliveryKind: params.deliveryKind,
		...params.sessionKey ? { sessionKey: params.sessionKey } : {}
	});
}
function emitMessageDeliveryCompleted(params) {
	emitDiagnosticEvent({
		type: "message.delivery.completed",
		channel: params.channel,
		deliveryKind: params.deliveryKind,
		durationMs: params.durationMs,
		resultCount: params.resultCount,
		...params.sessionKey ? { sessionKey: params.sessionKey } : {}
	});
}
function emitMessageDeliveryError(params) {
	emitDiagnosticEvent({
		type: "message.delivery.error",
		channel: params.channel,
		deliveryKind: params.deliveryKind,
		durationMs: params.durationMs,
		errorCategory: diagnosticErrorCategory(params.error),
		...params.sessionKey ? { sessionKey: params.sessionKey } : {}
	});
}
function normalizeEmptyPayloadForDelivery(payload) {
	const text = typeof payload.text === "string" ? payload.text : "";
	if (!text.trim()) {
		if (!hasReplyPayloadContent({
			...payload,
			text
		})) return null;
		if (text) return {
			...payload,
			text: ""
		};
	}
	return payload;
}
function normalizePayloadsForChannelDelivery(plan, handler) {
	const normalizedPayloads = [];
	for (const payload of projectOutboundPayloadPlanForDelivery(plan)) {
		let sanitizedPayload = stripInternalRuntimeScaffoldingFromPayload(payload);
		if (handler.sanitizeText && sanitizedPayload.text) {
			if (!handler.shouldSkipPlainTextSanitization?.(sanitizedPayload)) sanitizedPayload = {
				...sanitizedPayload,
				text: handler.sanitizeText(sanitizedPayload)
			};
		}
		const normalizedPayload = handler.normalizePayload ? handler.normalizePayload(sanitizedPayload) : sanitizedPayload;
		const normalized = normalizedPayload ? normalizeEmptyPayloadForDelivery(stripInternalRuntimeScaffoldingFromPayload(normalizedPayload)) : null;
		if (normalized) normalizedPayloads.push(normalized);
	}
	return normalizedPayloads;
}
function stripInternalRuntimeScaffoldingFromValue(value) {
	if (typeof value === "string") return stripInternalRuntimeScaffolding(value);
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((entry) => {
			const stripped = stripInternalRuntimeScaffoldingFromValue(entry);
			changed ||= stripped !== entry;
			return stripped;
		});
		return changed ? next : value;
	}
	if (!value || typeof value !== "object") return value;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return value;
	let changed = false;
	const next = {};
	for (const [key, entry] of Object.entries(value)) {
		const stripped = stripInternalRuntimeScaffoldingFromValue(entry);
		changed ||= stripped !== entry;
		next[key] = stripped;
	}
	return changed ? next : value;
}
function stripInternalRuntimeScaffoldingFromPayload(payload) {
	const stripped = stripInternalRuntimeScaffoldingFromValue(payload);
	return stripped && typeof stripped === "object" && !Array.isArray(stripped) ? stripped : payload;
}
function buildPayloadSummary(payload) {
	return summarizeOutboundPayloadForTransport(payload);
}
function hasDeliveryResultIdentity(result) {
	return Boolean(result.messageId || result.chatId || result.channelId || result.roomId || result.conversationId || result.toJid || result.pollId);
}
function normalizeDeliveryPin(payload) {
	const pin = payload.delivery?.pin;
	if (pin === true) return { enabled: true };
	if (!pin || typeof pin !== "object" || Array.isArray(pin)) return;
	if (!pin.enabled) return;
	const normalized = { enabled: true };
	if (pin.notify === true) normalized.notify = true;
	if (pin.required === true) normalized.required = true;
	return normalized;
}
async function maybePinDeliveredMessage(params) {
	const pin = normalizeDeliveryPin(params.payload);
	if (!pin) return;
	if (!params.messageId) {
		if (pin.required) throw new Error("Delivery pin requested, but no delivered message id was returned.");
		log.warn("Delivery pin requested, but no delivered message id was returned.", {
			channel: params.target.channel,
			to: params.target.to
		});
		return;
	}
	if (!params.handler.pinDeliveredMessage) {
		if (pin.required) throw new Error(`Delivery pin is not supported by channel: ${params.target.channel}`);
		log.warn("Delivery pin requested, but channel does not support pinning delivered messages.", {
			channel: params.target.channel,
			to: params.target.to
		});
		return;
	}
	try {
		await params.handler.pinDeliveredMessage({
			target: params.target,
			messageId: params.messageId,
			pin
		});
	} catch (err) {
		if (pin.required) throw err;
		log.warn("Delivery pin requested, but channel failed to pin delivered message.", {
			channel: params.target.channel,
			to: params.target.to,
			messageId: params.messageId,
			error: formatErrorMessage(err)
		});
	}
}
async function maybeNotifyAfterDeliveredPayload(params) {
	if (!params.handler.afterDeliverPayload || params.results.length === 0) return;
	try {
		await params.handler.afterDeliverPayload({
			target: params.target,
			payload: params.payload,
			results: params.results
		});
	} catch (err) {
		log.warn("Plugin outbound adapter after-delivery hook failed.", {
			channel: params.target.channel,
			to: params.target.to,
			error: formatErrorMessage(err)
		});
	}
}
async function renderPresentationForDelivery(handler, payload) {
	const presentation = normalizeMessagePresentation(payload.presentation);
	if (!presentation) return payload;
	const rendered = handler.renderPresentation ? await handler.renderPresentation(payload) : null;
	if (rendered) {
		const { presentation: _presentation, ...withoutPresentation } = rendered;
		return withoutPresentation;
	}
	const { presentation: _presentation, ...withoutPresentation } = payload;
	return {
		...withoutPresentation,
		text: renderMessagePresentationFallbackText({
			text: payload.text,
			presentation
		})
	};
}
function createMessageSentEmitter(params) {
	const hasMessageSentHooks = params.hookRunner?.hasHooks("message_sent") ?? false;
	const canEmitInternalHook = Boolean(params.sessionKeyForInternalHooks);
	const emitMessageSent = (event) => {
		if (!hasMessageSentHooks && !canEmitInternalHook) return;
		const canonical = buildCanonicalSentMessageHookContext({
			to: params.to,
			content: event.content,
			success: event.success,
			error: event.error,
			channelId: params.channel,
			accountId: params.accountId ?? void 0,
			conversationId: params.to,
			messageId: event.messageId,
			isGroup: params.mirrorIsGroup,
			groupId: params.mirrorGroupId
		});
		if (hasMessageSentHooks) fireAndForgetHook(params.hookRunner.runMessageSent(toPluginMessageSentEvent(canonical), toPluginMessageContext(canonical)), "deliverOutboundPayloads: message_sent plugin hook failed", (message) => {
			log.warn(message);
		});
		if (!canEmitInternalHook) return;
		fireAndForgetHook(triggerInternalHook(createInternalHookEvent("message", "sent", params.sessionKeyForInternalHooks, toInternalMessageSentContext(canonical))), "deliverOutboundPayloads: message:sent internal hook failed", (message) => {
			log.warn(message);
		});
	};
	return {
		emitMessageSent,
		hasMessageSentHooks
	};
}
async function applyMessageSendingHook(params) {
	if (!params.enabled) return {
		cancelled: false,
		payload: params.payload,
		payloadSummary: params.payloadSummary
	};
	try {
		const sendingResult = await params.hookRunner.runMessageSending({
			to: params.to,
			content: params.payloadSummary.hookContent ?? params.payloadSummary.text,
			replyToId: params.replyToId ?? void 0,
			threadId: params.threadId ?? void 0,
			metadata: {
				channel: params.channel,
				accountId: params.accountId,
				mediaUrls: params.payloadSummary.mediaUrls
			}
		}, {
			channelId: params.channel,
			accountId: params.accountId ?? void 0,
			conversationId: params.to
		});
		if (sendingResult?.cancel) return {
			cancelled: true,
			payload: params.payload,
			payloadSummary: params.payloadSummary
		};
		if (sendingResult?.content == null) return {
			cancelled: false,
			payload: params.payload,
			payloadSummary: params.payloadSummary
		};
		if (params.payloadSummary.hookContent && !params.payloadSummary.text) {
			const spokenText = sendingResult.content;
			return {
				cancelled: false,
				payload: {
					...params.payload,
					spokenText
				},
				payloadSummary: {
					...params.payloadSummary,
					hookContent: spokenText
				}
			};
		}
		return {
			cancelled: false,
			payload: {
				...params.payload,
				text: sendingResult.content
			},
			payloadSummary: {
				...params.payloadSummary,
				text: sendingResult.content
			}
		};
	} catch {
		return {
			cancelled: false,
			payload: params.payload,
			payloadSummary: params.payloadSummary
		};
	}
}
async function deliverOutboundPayloads(params) {
	const { channel, to, payloads } = params;
	const queueId = params.skipQueue ? null : await enqueueDelivery({
		channel,
		to,
		accountId: params.accountId,
		payloads,
		threadId: params.threadId,
		replyToId: params.replyToId,
		replyToMode: params.replyToMode,
		formatting: params.formatting,
		bestEffort: params.bestEffort,
		gifPlayback: params.gifPlayback,
		forceDocument: params.forceDocument,
		silent: params.silent,
		mirror: params.mirror,
		session: params.session,
		gatewayClientScopes: params.gatewayClientScopes
	}).catch(() => null);
	if (!queueId) return await deliverOutboundPayloadsWithQueueCleanup(params, null);
	const claimResult = await withActiveDeliveryClaim(queueId, () => deliverOutboundPayloadsWithQueueCleanup(params, queueId));
	if (claimResult.status === "claimed-by-other-owner") return [];
	return claimResult.value;
}
async function deliverOutboundPayloadsWithQueueCleanup(params, queueId) {
	let hadPartialFailure = false;
	const wrappedParams = params.onError ? {
		...params,
		onError: (err, payload) => {
			hadPartialFailure = true;
			params.onError(err, payload);
		}
	} : params;
	try {
		const results = await deliverOutboundPayloadsCore(wrappedParams);
		if (queueId) if (hadPartialFailure) await failDelivery(queueId, "partial delivery failure (bestEffort)").catch(() => {});
		else await ackDelivery(queueId).catch(() => {});
		return results;
	} catch (err) {
		if (queueId) if (isAbortError(err)) await ackDelivery(queueId).catch(() => {});
		else await failDelivery(queueId, formatErrorMessage(err)).catch(() => {});
		throw err;
	}
}
/** Core delivery logic (extracted for queue wrapper). */
async function deliverOutboundPayloadsCore(params) {
	const { cfg, channel, to, payloads } = params;
	const directiveOptions = await resolveChannelOutboundDirectiveOptions({
		cfg,
		channel
	});
	const outboundPayloadPlan = createOutboundPayloadPlan(payloads, {
		cfg,
		sessionKey: params.session?.policyKey ?? params.session?.key,
		surface: channel,
		conversationType: params.session?.conversationType,
		extractMarkdownImages: directiveOptions.extractMarkdownImages
	});
	const accountId = params.accountId;
	const deps = params.deps;
	const abortSignal = params.abortSignal;
	const mediaSources = collectPayloadMediaSources(outboundPayloadPlan);
	const mediaAccess = mediaSources.length > 0 ? resolveAgentScopedOutboundMediaAccess({
		cfg,
		agentId: params.session?.agentId ?? params.mirror?.agentId,
		mediaSources,
		mediaAccess: params.mediaAccess,
		sessionKey: params.session?.key,
		messageProvider: params.session?.key ? void 0 : channel,
		accountId: params.session?.requesterAccountId ?? accountId,
		requesterSenderId: params.session?.requesterSenderId,
		requesterSenderName: params.session?.requesterSenderName,
		requesterSenderUsername: params.session?.requesterSenderUsername,
		requesterSenderE164: params.session?.requesterSenderE164
	}) : params.mediaAccess ?? {};
	const results = [];
	const handler = await createChannelHandler({
		cfg,
		channel,
		to,
		deps,
		accountId,
		replyToId: params.replyToId,
		replyToMode: params.replyToMode,
		formatting: params.formatting,
		threadId: params.threadId,
		identity: params.identity,
		gifPlayback: params.gifPlayback,
		forceDocument: params.forceDocument,
		silent: params.silent,
		mediaAccess,
		gatewayClientScopes: params.gatewayClientScopes
	});
	const configuredTextLimit = handler.chunker ? resolveTextChunkLimit(cfg, channel, accountId, { fallbackLimit: handler.textChunkLimit }) : void 0;
	const textLimit = params.formatting?.textLimit ?? (handler.resolveEffectiveTextChunkLimit ? handler.resolveEffectiveTextChunkLimit(configuredTextLimit) : configuredTextLimit);
	const chunkMode = handler.chunker ? params.formatting?.chunkMode ?? resolveChunkMode(cfg, channel, accountId) : "length";
	const { resolveCurrentReplyTo, applyReplyToConsumption } = createReplyToDeliveryPolicy({
		replyToId: params.replyToId,
		replyToMode: params.replyToMode
	});
	const sendTextChunks = async (text, overrides = {}) => {
		const units = planOutboundTextMessageUnits({
			text,
			overrides,
			chunker: handler.chunker,
			chunkerMode: handler.chunkerMode,
			textLimit,
			chunkMode,
			formatting: params.formatting,
			consumeReplyTo: (value) => applyReplyToConsumption(value, { consumeImplicitReply: value.replyToIdSource === "implicit" })
		});
		for (const unit of units) {
			if (unit.kind !== "text") continue;
			throwIfAborted(abortSignal);
			results.push(await handler.sendText(unit.text, unit.overrides));
		}
	};
	const normalizedPayloads = normalizePayloadsForChannelDelivery(outboundPayloadPlan, handler);
	const hookRunner = getGlobalHookRunner();
	const sessionKeyForInternalHooks = params.mirror?.sessionKey ?? params.session?.key;
	const mirrorIsGroup = params.mirror?.isGroup;
	const mirrorGroupId = params.mirror?.groupId;
	const { emitMessageSent, hasMessageSentHooks } = createMessageSentEmitter({
		hookRunner,
		channel,
		to,
		accountId,
		sessionKeyForInternalHooks,
		mirrorIsGroup,
		mirrorGroupId
	});
	const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
	const diagnosticSessionKey = sessionKeyForDeliveryDiagnostics(params);
	if (hasMessageSentHooks && params.session?.agentId && !sessionKeyForInternalHooks) log.warn("deliverOutboundPayloads: session.agentId present without session key; internal message:sent hook will be skipped", {
		channel,
		to,
		agentId: params.session.agentId
	});
	for (const payload of normalizedPayloads) {
		let payloadSummary = buildPayloadSummary(payload);
		let deliveryKind = "other";
		let deliveryStartedAt = 0;
		let deliveryStarted = false;
		let deliveryFinished = false;
		const startDeliveryDiagnostics = (kind) => {
			deliveryKind = kind;
			deliveryStartedAt = Date.now();
			deliveryStarted = true;
			deliveryFinished = false;
			emitMessageDeliveryStarted({
				channel,
				deliveryKind,
				sessionKey: diagnosticSessionKey
			});
		};
		const completeDeliveryDiagnostics = (resultCount) => {
			if (!deliveryStarted) return;
			deliveryFinished = true;
			emitMessageDeliveryCompleted({
				channel,
				deliveryKind,
				durationMs: Date.now() - deliveryStartedAt,
				resultCount,
				sessionKey: diagnosticSessionKey
			});
		};
		const errorDeliveryDiagnostics = (err) => {
			if (!deliveryStarted || deliveryFinished) return;
			deliveryFinished = true;
			emitMessageDeliveryError({
				channel,
				deliveryKind,
				durationMs: Date.now() - deliveryStartedAt,
				error: err,
				sessionKey: diagnosticSessionKey
			});
		};
		try {
			throwIfAborted(abortSignal);
			const hookResult = await applyMessageSendingHook({
				hookRunner,
				enabled: hasMessageSendingHooks,
				payload,
				payloadSummary,
				to,
				channel,
				accountId,
				replyToId: resolveCurrentReplyTo(payload).replyToId,
				threadId: params.threadId
			});
			if (hookResult.cancelled) continue;
			const renderedPayload = stripInternalRuntimeScaffoldingFromPayload(await renderPresentationForDelivery(handler, hookResult.payload));
			const normalizedEffectivePayload = handler.normalizePayload ? handler.normalizePayload(renderedPayload) : renderedPayload;
			const effectivePayload = normalizedEffectivePayload ? normalizeEmptyPayloadForDelivery(stripInternalRuntimeScaffoldingFromPayload(normalizedEffectivePayload)) : null;
			if (!effectivePayload) continue;
			payloadSummary = buildPayloadSummary(effectivePayload);
			startDeliveryDiagnostics(deliveryKindForPayload(effectivePayload, payloadSummary));
			params.onPayload?.(payloadSummary);
			const replyToResolution = resolveCurrentReplyTo(effectivePayload);
			const sendOverrides = {
				replyToId: replyToResolution.replyToId,
				replyToIdSource: replyToResolution.source,
				...params.threadId !== void 0 ? { threadId: params.threadId } : {},
				...effectivePayload.audioAsVoice === true ? { audioAsVoice: true } : {},
				...params.forceDocument !== void 0 ? { forceDocument: params.forceDocument } : {}
			};
			const applySendReplyToConsumption = (overrides) => applyReplyToConsumption(overrides, { consumeImplicitReply: replyToResolution.source === "implicit" });
			const deliveryTarget = handler.buildTargetRef({ threadId: sendOverrides.threadId });
			if (handler.sendPayload && (effectivePayload.isError === true && handler.sendTextOnlyErrorPayloads === true || hasReplyPayloadContent({
				presentation: effectivePayload.presentation,
				interactive: effectivePayload.interactive,
				channelData: effectivePayload.channelData
			}) || effectivePayload.audioAsVoice === true)) {
				const delivery = await handler.sendPayload(effectivePayload, applySendReplyToConsumption(sendOverrides));
				if (!hasDeliveryResultIdentity(delivery)) {
					completeDeliveryDiagnostics(0);
					continue;
				}
				results.push(delivery);
				await maybePinDeliveredMessage({
					handler,
					payload: effectivePayload,
					target: deliveryTarget,
					messageId: delivery.messageId
				});
				await maybeNotifyAfterDeliveredPayload({
					handler,
					payload: effectivePayload,
					target: deliveryTarget,
					results: [delivery]
				});
				completeDeliveryDiagnostics(1);
				emitMessageSent({
					success: true,
					content: payloadSummary.hookContent ?? payloadSummary.text,
					messageId: delivery.messageId
				});
				continue;
			}
			if (payloadSummary.mediaUrls.length === 0) {
				const beforeCount = results.length;
				if (handler.sendFormattedText) results.push(...await handler.sendFormattedText(payloadSummary.text, applySendReplyToConsumption(sendOverrides)));
				else await sendTextChunks(payloadSummary.text, sendOverrides);
				const deliveredResults = results.slice(beforeCount);
				const messageId = results.at(-1)?.messageId;
				const pinMessageId = deliveredResults.find((entry) => entry.messageId)?.messageId;
				await maybePinDeliveredMessage({
					handler,
					payload: effectivePayload,
					target: deliveryTarget,
					messageId: pinMessageId
				});
				await maybeNotifyAfterDeliveredPayload({
					handler,
					payload: effectivePayload,
					target: deliveryTarget,
					results: deliveredResults
				});
				completeDeliveryDiagnostics(deliveredResults.length);
				emitMessageSent({
					success: results.length > beforeCount,
					content: payloadSummary.hookContent ?? payloadSummary.text,
					messageId
				});
				continue;
			}
			if (!handler.supportsMedia) {
				log.warn("Plugin outbound adapter does not implement sendMedia; media URLs will be dropped and text fallback will be used", {
					channel,
					to,
					mediaCount: payloadSummary.mediaUrls.length
				});
				const fallbackText = payloadSummary.text.trim();
				if (!fallbackText) throw new Error("Plugin outbound adapter does not implement sendMedia and no text fallback is available for media payload");
				const beforeCount = results.length;
				await sendTextChunks(fallbackText, sendOverrides);
				const deliveredResults = results.slice(beforeCount);
				const messageId = results.at(-1)?.messageId;
				const pinMessageId = deliveredResults.find((entry) => entry.messageId)?.messageId;
				await maybePinDeliveredMessage({
					handler,
					payload: effectivePayload,
					target: deliveryTarget,
					messageId: pinMessageId
				});
				await maybeNotifyAfterDeliveredPayload({
					handler,
					payload: effectivePayload,
					target: deliveryTarget,
					results: deliveredResults
				});
				completeDeliveryDiagnostics(deliveredResults.length);
				emitMessageSent({
					success: results.length > beforeCount,
					content: payloadSummary.hookContent ?? payloadSummary.text,
					messageId
				});
				continue;
			}
			let firstMessageId;
			let lastMessageId;
			const beforeCount = results.length;
			const mediaUnits = planOutboundMediaMessageUnits({
				mediaUrls: payloadSummary.mediaUrls,
				caption: payloadSummary.text,
				overrides: sendOverrides,
				consumeReplyTo: applySendReplyToConsumption
			});
			for (const unit of mediaUnits) {
				if (unit.kind !== "media") continue;
				throwIfAborted(abortSignal);
				const delivery = handler.sendFormattedMedia ? await handler.sendFormattedMedia(unit.caption ?? "", unit.mediaUrl, unit.overrides) : await handler.sendMedia(unit.caption ?? "", unit.mediaUrl, unit.overrides);
				results.push(delivery);
				firstMessageId ??= delivery.messageId;
				lastMessageId = delivery.messageId;
			}
			await maybePinDeliveredMessage({
				handler,
				payload: effectivePayload,
				target: deliveryTarget,
				messageId: firstMessageId
			});
			await maybeNotifyAfterDeliveredPayload({
				handler,
				payload: effectivePayload,
				target: deliveryTarget,
				results: results.slice(beforeCount)
			});
			completeDeliveryDiagnostics(results.length - beforeCount);
			emitMessageSent({
				success: true,
				content: payloadSummary.hookContent ?? payloadSummary.text,
				messageId: lastMessageId
			});
		} catch (err) {
			errorDeliveryDiagnostics(err);
			emitMessageSent({
				success: false,
				content: payloadSummary.hookContent ?? payloadSummary.text,
				error: formatErrorMessage(err)
			});
			if (!params.bestEffort) throw err;
			params.onError?.(err, payloadSummary);
		}
	}
	if (params.mirror && results.length > 0) {
		const mirrorText = resolveMirroredTranscriptText({
			text: params.mirror.text,
			mediaUrls: params.mirror.mediaUrls
		});
		if (mirrorText) {
			const { appendAssistantMessageToSessionTranscript } = await loadTranscriptRuntime();
			await appendAssistantMessageToSessionTranscript({
				agentId: params.mirror.agentId,
				sessionKey: params.mirror.sessionKey,
				text: mirrorText,
				idempotencyKey: params.mirror.idempotencyKey,
				config: params.cfg
			});
		}
	}
	return results;
}
//#endregion
export { normalizeReplyPayloadsForDelivery as a, projectOutboundPayloadPlanForMirror as c, parseReplyDirectives as d, normalizeOutboundPayloadsForJson as i, projectOutboundPayloadPlanForOutbound as l, createOutboundPayloadPlan as n, projectOutboundPayloadPlanForDelivery as o, formatOutboundPayloadLog as r, projectOutboundPayloadPlanForJson as s, deliverOutboundPayloads as t, throwIfAborted as u };
