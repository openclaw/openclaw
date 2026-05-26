import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { _ as runOutboundDeliveryCommitHooks, c as enqueueDelivery, g as attachOutboundDeliveryCommitHook, m as markDeliveryPlatformSendAttemptStarted, o as withActiveDeliveryClaim, p as markDeliveryPlatformOutcomeUnknown, s as ackDelivery, u as failDelivery } from "./delivery-queue-DiT8Zaph.js";
import { n as emitDiagnosticEvent } from "./diagnostic-events-BLgzARSp.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { t as getGlobalHookRunner, u as fireAndForgetHook } from "./hook-runner-global-BkXXy1ub.js";
import { m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-DpfQDjis.js";
import { s as resolveMirroredTranscriptText } from "./transcript-BA0Ngd-A.js";
import { a as toInternalMessageSentContext, d as toPluginMessageSentEvent, l as toPluginMessageContext, t as buildCanonicalSentMessageHookContext } from "./message-hook-mappers-CNfn6PTM.js";
import { C as createReplyToDeliveryPolicy } from "./reply-payload-DMPQsrQC.js";
import { a as hasReplyPayloadContent, f as renderMessagePresentationFallbackText, l as normalizeMessagePresentation } from "./payload-BDV15CYA.js";
import { t as diagnosticErrorCategory } from "./diagnostic-error-metadata-CJCFvsh5.js";
import { l as summarizeOutboundPayloadForTransport, t as createOutboundPayloadPlan } from "./payloads-BOM5t2O4.js";
import { c as resolveTextChunkLimit, i as chunkMarkdownTextWithMode, n as chunkByParagraph, s as resolveChunkMode } from "./chunk-IIklKK4Y.js";
import { n as adaptMessagePresentationForChannel } from "./interactive-DO_VR-vH.js";
import { t as loadChannelOutboundAdapter } from "./load-CvxrRePI.js";
import { t as resolveAgentScopedOutboundMediaAccess } from "./read-capability-CUZ0OarG.js";
import { n as resolveOutboundChannelMessageAdapter } from "./channel-resolution-Ecs0HEdK.js";
import { n as stripInternalRuntimeScaffolding } from "./sanitize-text-LnH5cJvF.js";
//#region src/infra/outbound/deliver-types.ts
var OutboundDeliveryError = class extends Error {
	constructor(message, options) {
		super(message, { cause: options.cause });
		this.name = "OutboundDeliveryError";
		this.results = [...options.results ?? []];
		this.payloadOutcomes = [...options.payloadOutcomes ?? []];
		this.sentBeforeError = this.results.length > 0;
		this.stage = options.stage ?? "unknown";
	}
};
function isOutboundDeliveryError(error) {
	return error instanceof OutboundDeliveryError;
}
//#endregion
//#region src/channels/message/rendered-batch.ts
function countMedia(payload) {
	return (payload.mediaUrls?.filter(Boolean).length ?? 0) + (payload.mediaUrl ? 1 : 0);
}
function collectMediaUrls(payload) {
	return [payload.mediaUrl, ...payload.mediaUrls ?? []].map((url) => url?.trim()).filter((url) => Boolean(url));
}
function createRenderedMessageBatchPlanItem(payload, index) {
	const text = payload.text?.trim();
	const mediaUrls = collectMediaUrls(payload);
	const presentationBlockCount = payload.presentation?.blocks?.length ?? 0;
	const kinds = [];
	if (text) kinds.push("text");
	if (mediaUrls.length > 0) kinds.push(payload.audioAsVoice ? "voice" : "media");
	if (presentationBlockCount > 0) kinds.push("presentation");
	if (payload.interactive) kinds.push("interactive");
	if (payload.channelData) kinds.push("channelData");
	return {
		index,
		kinds: kinds.length > 0 ? kinds : ["empty"],
		...text ? { text } : {},
		mediaUrls,
		...payload.audioAsVoice && mediaUrls.length > 0 ? { audioAsVoice: true } : {},
		...presentationBlockCount > 0 ? { presentationBlockCount } : {},
		...payload.interactive ? { hasInteractive: true } : {},
		...payload.channelData ? { hasChannelData: true } : {}
	};
}
function createRenderedMessageBatchPlan(payloads) {
	const items = payloads.map(createRenderedMessageBatchPlanItem);
	return payloads.reduce((plan, payload) => {
		const text = payload.text?.trim();
		const mediaCount = countMedia(payload);
		return {
			payloadCount: plan.payloadCount + 1,
			textCount: plan.textCount + (text ? 1 : 0),
			mediaCount: plan.mediaCount + mediaCount,
			voiceCount: plan.voiceCount + (payload.audioAsVoice && mediaCount > 0 ? 1 : 0),
			presentationCount: plan.presentationCount + (payload.presentation?.blocks?.length ? 1 : 0),
			interactiveCount: plan.interactiveCount + (payload.interactive ? 1 : 0),
			channelDataCount: plan.channelDataCount + (payload.channelData ? 1 : 0),
			items: plan.items
		};
	}, {
		payloadCount: 0,
		textCount: 0,
		mediaCount: 0,
		voiceCount: 0,
		presentationCount: 0,
		interactiveCount: 0,
		channelDataCount: 0,
		items
	});
}
function createRenderedMessageBatch(payloads) {
	return {
		payloads,
		plan: createRenderedMessageBatchPlan(payloads)
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
function withChunkedTextFormatting(overrides, formatting) {
	return formatting ? {
		...overrides,
		formatting: {
			...overrides.formatting,
			...formatting
		}
	} : overrides;
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
	const planChunkedTextUnit = (text) => {
		const unit = planTextUnit(text);
		return {
			...unit,
			overrides: withChunkedTextFormatting(unit.overrides, params.chunkedTextFormatting)
		};
	};
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
			for (const chunk of chunks) units.push(planChunkedTextUnit(chunk));
		}
		return units;
	}
	return chunkTextForPlan({
		text: params.text,
		limit: params.textLimit,
		chunker: params.chunker,
		formatting: params.formatting
	}).map(planChunkedTextUnit);
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
//#region src/infra/outbound/deliver.ts
const log = createSubsystemLogger("outbound/deliver");
let transcriptRuntimePromise;
async function loadTranscriptRuntime() {
	transcriptRuntimePromise ??= import("./transcript.runtime.js");
	return await transcriptRuntimePromise;
}
let channelBootstrapRuntimePromise;
async function loadChannelBootstrapRuntime() {
	channelBootstrapRuntimePromise ??= import("./channel-bootstrap.runtime-B0t3vnup.js");
	return await channelBootstrapRuntimePromise;
}
async function resolveChannelOutboundDirectiveOptions(params) {
	return { extractMarkdownImages: (await loadBootstrappedOutboundAdapter(params))?.extractMarkdownImages === true ? true : void 0 };
}
async function createChannelHandler(params) {
	const outbound = await loadBootstrappedOutboundAdapter(params);
	const message = resolveOutboundChannelMessageAdapter(params);
	const handler = createPluginHandler({
		...params,
		outbound,
		message
	});
	if (!handler) throw new Error(`Outbound not configured for channel: ${params.channel}`);
	return handler;
}
async function loadBootstrappedOutboundAdapter(params) {
	let outbound = await loadChannelOutboundAdapter(params.channel);
	if (!outbound) {
		const { bootstrapOutboundChannelPlugin } = await loadChannelBootstrapRuntime();
		bootstrapOutboundChannelPlugin({
			channel: params.channel,
			cfg: params.cfg
		});
		outbound = await loadChannelOutboundAdapter(params.channel);
	}
	return outbound;
}
async function runChannelMessageSendWithLifecycle(params) {
	if (!params.lifecycle) return { result: await params.send() };
	let attemptToken;
	try {
		attemptToken = await params.lifecycle.beforeSendAttempt?.(params.ctx);
		const result = await params.send();
		const successCtx = {
			...params.ctx,
			result,
			...attemptToken !== void 0 ? { attemptToken } : {}
		};
		try {
			await params.lifecycle.afterSendSuccess?.(successCtx);
		} catch (successHookError) {
			log.warn(`channel message send success hook failed after platform send; preserving send result: ${formatErrorMessage(successHookError)}`);
		}
		return {
			result,
			...params.lifecycle.afterCommit ? { afterCommit: async () => {
				await params.lifecycle?.afterCommit?.(successCtx);
			} } : {}
		};
	} catch (error) {
		try {
			await params.lifecycle.afterSendFailure?.({
				...params.ctx,
				error,
				...attemptToken !== void 0 ? { attemptToken } : {}
			});
		} catch (cleanupError) {
			log.warn(`channel message send failure cleanup failed; preserving original send error: ${formatErrorMessage(cleanupError)}`);
		}
		throw error;
	}
}
async function resolveOutboundDurableFinalDeliverySupport(params) {
	const outbound = await loadBootstrappedOutboundAdapter(params);
	const message = resolveOutboundChannelMessageAdapter(params);
	if (!message?.send?.text && !outbound?.sendText) return {
		ok: false,
		reason: "missing_outbound_handler"
	};
	const messageDurableFinal = message?.durableFinal;
	const durableFinal = messageDurableFinal?.capabilities ?? outbound?.deliveryCapabilities?.durableFinal;
	for (const [capability, required] of Object.entries(params.requirements ?? {})) {
		if (required === true && durableFinal?.[capability] !== true) return {
			ok: false,
			reason: "capability_mismatch",
			capability
		};
		if (required === true && capability === "reconcileUnknownSend" && typeof messageDurableFinal?.reconcileUnknownSend !== "function") return {
			ok: false,
			reason: "capability_mismatch",
			capability
		};
	}
	return { ok: true };
}
function createPluginHandler(params) {
	const outbound = params.outbound;
	const messageText = params.message?.send?.text;
	const messageMedia = params.message?.send?.media;
	const messagePayload = params.message?.send?.payload;
	const messageLifecycle = params.message?.send?.lifecycle;
	if (!messageText && !outbound?.sendText) return null;
	const baseCtx = createChannelOutboundContextBase(params);
	const sendText = outbound?.sendText;
	const sendMedia = outbound?.sendMedia;
	const chunker = outbound?.chunker ?? null;
	const chunkerMode = outbound?.chunkerMode;
	const resolveCtx = (overrides) => ({
		...baseCtx,
		replyToId: overrides && "replyToId" in overrides ? overrides.replyToId : baseCtx.replyToId,
		replyToIdSource: overrides && "replyToIdSource" in overrides ? overrides.replyToIdSource : baseCtx.replyToIdSource,
		threadId: overrides && "threadId" in overrides ? overrides.threadId : baseCtx.threadId,
		audioAsVoice: overrides?.audioAsVoice,
		formatting: overrides && "formatting" in overrides ? {
			...baseCtx.formatting,
			...overrides.formatting
		} : baseCtx.formatting
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
		chunkedTextFormatting: outbound?.chunkedTextFormatting,
		textChunkLimit: outbound?.textChunkLimit,
		supportsMedia: Boolean(messageMedia ?? sendMedia),
		sanitizeText: outbound?.sanitizeText ? (payload) => outbound.sanitizeText({
			text: payload.text ?? "",
			payload
		}) : void 0,
		normalizePayload: outbound?.normalizePayload ? (payload) => outbound.normalizePayload({
			payload,
			cfg: params.cfg,
			accountId: params.accountId
		}) : void 0,
		sendTextOnlyErrorPayloads: outbound?.sendTextOnlyErrorPayloads === true,
		presentationCapabilities: outbound?.presentationCapabilities,
		renderPresentation: outbound?.renderPresentation ? async (payload) => {
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
		pinDeliveredMessage: outbound?.pinDeliveredMessage ? async ({ target, messageId, pin }) => outbound.pinDeliveredMessage({
			cfg: params.cfg,
			target,
			messageId,
			pin
		}) : void 0,
		afterDeliverPayload: outbound?.afterDeliverPayload ? async ({ target, payload, results }) => outbound.afterDeliverPayload({
			cfg: params.cfg,
			target,
			payload,
			results
		}) : void 0,
		shouldSkipPlainTextSanitization: outbound?.shouldSkipPlainTextSanitization ? (payload) => outbound.shouldSkipPlainTextSanitization({ payload }) : void 0,
		resolveEffectiveTextChunkLimit: outbound?.resolveEffectiveTextChunkLimit ? (fallbackLimit) => outbound.resolveEffectiveTextChunkLimit({
			cfg: params.cfg,
			accountId: params.accountId ?? void 0,
			fallbackLimit
		}) : void 0,
		sendPayload: messagePayload || outbound?.sendPayload ? async (payload, overrides) => {
			const payloadCtx = {
				...resolveCtx(overrides),
				kind: "payload",
				text: payload.text ?? "",
				mediaUrl: payload.mediaUrl,
				payload
			};
			if (messagePayload) {
				const sent = await runChannelMessageSendWithLifecycle({
					lifecycle: messageLifecycle,
					ctx: payloadCtx,
					send: async () => {
						await params.onPlatformSendStart?.();
						return await messagePayload(payloadCtx);
					}
				});
				return attachOutboundDeliveryCommitHook(normalizeChannelMessageSendResult(params.channel, sent.result), sent.afterCommit);
			}
			await params.onPlatformSendStart?.();
			return outbound.sendPayload(payloadCtx);
		} : void 0,
		sendFormattedText: outbound?.sendFormattedText ? async (text, overrides) => {
			await params.onPlatformSendStart?.();
			return await outbound.sendFormattedText({
				...resolveCtx(overrides),
				text
			});
		} : void 0,
		sendFormattedMedia: outbound?.sendFormattedMedia ? async (caption, mediaUrl, overrides) => {
			await params.onPlatformSendStart?.();
			return await outbound.sendFormattedMedia({
				...resolveCtx(overrides),
				text: caption,
				mediaUrl
			});
		} : void 0,
		sendText: async (text, overrides) => {
			const textCtx = {
				...resolveCtx(overrides),
				kind: "text",
				text
			};
			if (messageText) {
				const sent = await runChannelMessageSendWithLifecycle({
					lifecycle: messageLifecycle,
					ctx: textCtx,
					send: async () => {
						await params.onPlatformSendStart?.();
						return await messageText(textCtx);
					}
				});
				return attachOutboundDeliveryCommitHook(normalizeChannelMessageSendResult(params.channel, sent.result), sent.afterCommit);
			}
			await params.onPlatformSendStart?.();
			return sendText(textCtx);
		},
		buildTargetRef,
		sendMedia: async (caption, mediaUrl, overrides) => {
			const mediaCtx = {
				...resolveCtx(overrides),
				kind: "media",
				text: caption,
				mediaUrl
			};
			if (messageMedia) {
				const sent = await runChannelMessageSendWithLifecycle({
					lifecycle: messageLifecycle,
					ctx: mediaCtx,
					send: async () => {
						await params.onPlatformSendStart?.();
						return await messageMedia(mediaCtx);
					}
				});
				return attachOutboundDeliveryCommitHook(normalizeChannelMessageSendResult(params.channel, sent.result), sent.afterCommit);
			}
			if (sendMedia) {
				await params.onPlatformSendStart?.();
				return sendMedia(mediaCtx);
			}
			await params.onPlatformSendStart?.();
			return sendText(mediaCtx);
		}
	};
}
function normalizeChannelMessageSendResult(channel, result) {
	const source = result;
	return {
		...source,
		channel,
		messageId: source.messageId ?? source.receipt.primaryPlatformMessageId ?? source.receipt.platformMessageIds[0] ?? "",
		receipt: source.receipt
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
const isDeliveryAbortError = (err) => isAbortError(err) || err instanceof OutboundDeliveryError && isAbortError(err.cause);
async function markQueuedPlatformSendAttemptStarted(params) {
	try {
		await markDeliveryPlatformSendAttemptStarted(params.queueId);
		return true;
	} catch (err) {
		if (params.queuePolicy === "required") throw err;
		log.warn(`failed to mark queued delivery ${params.queueId} as platform-send-attempt-started; continuing best-effort delivery: ${formatErrorMessage(err)}`);
		return false;
	}
}
async function markQueuedPlatformOutcomeUnknown(params) {
	try {
		await markDeliveryPlatformOutcomeUnknown(params.queueId);
	} catch (err) {
		if (params.queuePolicy === "required") throw err;
		log.warn(`failed to mark queued delivery ${params.queueId} as platform-outcome-unknown; continuing best-effort delivery: ${formatErrorMessage(err)}`);
	}
}
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
	for (const entry of plan) {
		let sanitizedPayload = stripInternalRuntimeScaffoldingFromPayload(entry.payload);
		if (handler.sanitizeText && sanitizedPayload.text) {
			if (!handler.shouldSkipPlainTextSanitization?.(sanitizedPayload)) sanitizedPayload = {
				...sanitizedPayload,
				text: handler.sanitizeText(sanitizedPayload)
			};
		}
		const normalizedPayload = handler.normalizePayload ? handler.normalizePayload(sanitizedPayload) : sanitizedPayload;
		const normalized = normalizedPayload ? normalizeEmptyPayloadForDelivery(stripInternalRuntimeScaffoldingFromPayload(normalizedPayload)) : null;
		if (normalized) normalizedPayloads.push({
			index: entry.sourceIndex,
			payload: normalized
		});
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
	const adaptedPresentation = adaptMessagePresentationForChannel({
		presentation,
		capabilities: handler.presentationCapabilities
	});
	const adaptedPayload = {
		...payload,
		presentation: adaptedPresentation
	};
	const rendered = handler.renderPresentation ? await handler.renderPresentation(adaptedPayload) : null;
	if (rendered) {
		const { presentation: _presentation, ...withoutPresentation } = rendered;
		return withoutPresentation;
	}
	const { presentation: _presentation, ...withoutPresentation } = payload;
	return {
		...withoutPresentation,
		text: renderMessagePresentationFallbackText({
			text: payload.text,
			presentation: adaptedPresentation
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
		contentRewritten: false,
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
			...sendingResult.cancelReason ? { cancelReason: sendingResult.cancelReason } : {},
			...sendingResult.metadata ? { hookMetadata: sendingResult.metadata } : {},
			contentRewritten: false,
			payload: params.payload,
			payloadSummary: params.payloadSummary
		};
		if (sendingResult?.content == null) return {
			cancelled: false,
			contentRewritten: false,
			payload: params.payload,
			payloadSummary: params.payloadSummary
		};
		if (params.payloadSummary.hookContent && !params.payloadSummary.text) {
			const spokenText = sendingResult.content;
			return {
				cancelled: false,
				contentRewritten: true,
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
			contentRewritten: true,
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
			contentRewritten: false,
			payload: params.payload,
			payloadSummary: params.payloadSummary
		};
	}
}
function toOutboundDeliveryError(params) {
	if (params.error instanceof OutboundDeliveryError) return params.error;
	return new OutboundDeliveryError(formatErrorMessage(params.error), {
		cause: params.error,
		results: params.results,
		payloadOutcomes: params.payloadOutcomes,
		stage: params.stage
	});
}
function suppressedPayloadOutcome(params) {
	return {
		index: params.index,
		status: "suppressed",
		reason: params.reason,
		...params.hookEffect ? { hookEffect: params.hookEffect } : {}
	};
}
/**
* @deprecated Direct outbound delivery is compatibility/runtime substrate.
* New message lifecycle code should use `sendDurableMessageBatch` from
* `src/channels/message/send.ts` or `deliverInboundReplyWithMessageSendContext`
* from `src/channels/turn/durable-delivery.ts`. Keep direct use only for
* outbound substrate, recovery, and compatibility paths.
*/
async function deliverOutboundPayloads(params) {
	return await deliverOutboundPayloadsInternal(params);
}
async function deliverOutboundPayloadsInternal(params) {
	const { channel, to, payloads } = params;
	const queuePolicy = params.queuePolicy ?? "best_effort";
	const queuePayloads = payloads.map(stripInternalRuntimeScaffoldingFromPayload);
	const queuePayloadsChanged = queuePayloads.some((payload, index) => payload !== payloads[index]);
	const renderedBatchPlan = params.renderedBatchPlan ?? createRenderedMessageBatchPlan(params.payloads);
	const queueRenderedBatchPlan = queuePayloadsChanged ? createRenderedMessageBatchPlan(queuePayloads) : renderedBatchPlan;
	const queueId = params.skipQueue ? null : await enqueueDelivery({
		channel,
		to,
		accountId: params.accountId,
		payloads: queuePayloads,
		renderedBatchPlan: queueRenderedBatchPlan,
		threadId: params.threadId,
		replyToId: params.replyToId,
		replyToMode: params.replyToMode,
		formatting: params.formatting,
		identity: params.identity,
		bestEffort: params.bestEffort,
		gifPlayback: params.gifPlayback,
		forceDocument: params.forceDocument,
		silent: params.silent,
		mirror: params.mirror,
		session: params.session,
		gatewayClientScopes: params.gatewayClientScopes
	}).catch((err) => {
		if (queuePolicy === "required") throw err;
		return null;
	});
	if (queueId) params.onDeliveryIntent?.({
		id: queueId,
		channel,
		to,
		...params.accountId ? { accountId: params.accountId } : {},
		queuePolicy
	});
	if (!queueId) return await deliverOutboundPayloadsWithQueueCleanup(params, null);
	const claimResult = await withActiveDeliveryClaim(queueId, () => deliverOutboundPayloadsWithQueueCleanup(params, queueId));
	if (claimResult.status === "claimed-by-other-owner") return [];
	return claimResult.value;
}
async function deliverOutboundPayloadsWithQueueCleanup(params, queueId) {
	let hadPartialFailure = false;
	const wrappedParams = {
		...params,
		onError: (err, payload) => {
			hadPartialFailure = true;
			params.onError?.(err, payload);
		}
	};
	const queuePolicy = params.queuePolicy ?? "best_effort";
	let platformResultsReturned = false;
	try {
		let platformSendStarted = false;
		const results = await deliverOutboundPayloadsCore({
			...wrappedParams,
			...queueId ? { onPlatformSendStart: async () => {
				if (platformSendStarted) return;
				platformSendStarted = await markQueuedPlatformSendAttemptStarted({
					queueId,
					queuePolicy
				});
			} } : {}
		});
		platformResultsReturned = true;
		if (!queueId) {
			if (!params.deferCommitHooks) await runOutboundDeliveryCommitHooks(results);
			return results;
		}
		if (queueId) if (hadPartialFailure) await failDelivery(queueId, "partial delivery failure (bestEffort)").catch((err) => {
			log.warn(`failed to mark queued delivery ${queueId} as failed after partial failure; continuing best-effort delivery: ${formatErrorMessage(err)}`);
		});
		else {
			if (platformSendStarted) await markQueuedPlatformOutcomeUnknown({
				queueId,
				queuePolicy
			});
			if (await ackDelivery(queueId).then(() => true).catch((err) => {
				if (queuePolicy === "required") throw err;
				log.warn(`failed to ack queued delivery ${queueId}; continuing best-effort delivery: ${formatErrorMessage(err)}`);
				return false;
			})) await runOutboundDeliveryCommitHooks(results);
		}
		return results;
	} catch (err) {
		if (queueId) {
			if (isDeliveryAbortError(err)) await ackDelivery(queueId).catch(() => {});
			else if (!platformResultsReturned) await failDelivery(queueId, formatErrorMessage(err)).catch((failErr) => {
				log.warn(`failed to mark queued delivery ${queueId} as failed: ${formatErrorMessage(failErr)}`);
			});
		}
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
		gatewayClientScopes: params.gatewayClientScopes,
		...params.onPlatformSendStart ? { onPlatformSendStart: params.onPlatformSendStart } : {}
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
			chunkedTextFormatting: handler.chunkedTextFormatting,
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
	const payloadOutcomes = [];
	const recordPayloadOutcome = (outcome) => {
		payloadOutcomes.push(outcome);
		params.onPayloadDeliveryOutcome?.(outcome);
	};
	if (normalizedPayloads.length === 0 && payloads.length > 0) payloads.forEach((_payload, index) => {
		recordPayloadOutcome(suppressedPayloadOutcome({
			index,
			reason: "no_visible_payload"
		}));
	});
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
	for (const { index: payloadIndex, payload } of normalizedPayloads) {
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
			if (hookResult.cancelled) {
				const hookEffect = hookResult.cancelReason || hookResult.hookMetadata ? {
					...hookResult.cancelReason ? { cancelReason: hookResult.cancelReason } : {},
					...hookResult.hookMetadata ? { metadata: hookResult.hookMetadata } : {}
				} : void 0;
				recordPayloadOutcome(suppressedPayloadOutcome({
					index: payloadIndex,
					reason: "cancelled_by_message_sending_hook",
					...hookEffect ? { hookEffect } : {}
				}));
				continue;
			}
			const renderedPayload = stripInternalRuntimeScaffoldingFromPayload(await renderPresentationForDelivery(handler, hookResult.payload));
			const normalizedEffectivePayload = handler.normalizePayload ? handler.normalizePayload(renderedPayload) : renderedPayload;
			const effectivePayload = normalizedEffectivePayload ? normalizeEmptyPayloadForDelivery(stripInternalRuntimeScaffoldingFromPayload(normalizedEffectivePayload)) : null;
			if (!effectivePayload) {
				recordPayloadOutcome(suppressedPayloadOutcome({
					index: payloadIndex,
					reason: hookResult.contentRewritten ? "empty_after_message_sending_hook" : "no_visible_payload"
				}));
				continue;
			}
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
					recordPayloadOutcome(suppressedPayloadOutcome({
						index: payloadIndex,
						reason: "adapter_returned_no_identity"
					}));
					continue;
				}
				results.push(delivery);
				recordPayloadOutcome({
					index: payloadIndex,
					status: "sent",
					results: [delivery]
				});
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
				if (deliveredResults.length > 0) recordPayloadOutcome({
					index: payloadIndex,
					status: "sent",
					results: deliveredResults
				});
				else recordPayloadOutcome(suppressedPayloadOutcome({
					index: payloadIndex,
					reason: "adapter_returned_no_identity"
				}));
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
				if (deliveredResults.length > 0) recordPayloadOutcome({
					index: payloadIndex,
					status: "sent",
					results: deliveredResults
				});
				else recordPayloadOutcome(suppressedPayloadOutcome({
					index: payloadIndex,
					reason: "adapter_returned_no_identity"
				}));
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
			const deliveredResults = results.slice(beforeCount);
			if (deliveredResults.length > 0) recordPayloadOutcome({
				index: payloadIndex,
				status: "sent",
				results: deliveredResults
			});
			else recordPayloadOutcome(suppressedPayloadOutcome({
				index: payloadIndex,
				reason: "adapter_returned_no_identity"
			}));
			completeDeliveryDiagnostics(results.length - beforeCount);
			emitMessageSent({
				success: true,
				content: payloadSummary.hookContent ?? payloadSummary.text,
				messageId: lastMessageId
			});
		} catch (err) {
			recordPayloadOutcome({
				index: payloadIndex,
				status: "failed",
				error: err,
				sentBeforeError: results.length > 0,
				stage: "platform_send"
			});
			errorDeliveryDiagnostics(err);
			emitMessageSent({
				success: false,
				content: payloadSummary.hookContent ?? payloadSummary.text,
				error: formatErrorMessage(err)
			});
			if (!params.bestEffort) throw toOutboundDeliveryError({
				error: err,
				results,
				payloadOutcomes,
				stage: "platform_send"
			});
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
export { createRenderedMessageBatch as a, throwIfAborted as i, deliverOutboundPayloadsInternal as n, isOutboundDeliveryError as o, resolveOutboundDurableFinalDeliverySupport as r, deliverOutboundPayloads as t };
