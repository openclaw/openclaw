import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as createLazyImportLoader } from "./lazy-promise-SFT4i6yI.js";
import { r as logVerbose } from "./globals-DaPK6X5S.js";
import { l as mimeTypeFromFilePath } from "./mime-BjHvxzTf.js";
import { o as getReplyPayloadMetadata } from "./reply-reference-BMb_keYF.js";
import { m as resolveSendableOutboundReplyParts, s as hasOutboundReplyContent } from "./reply-payload-DT1jUOfQ.js";
function isRemotePath(value) {
	if (/^[a-z]:[\\/]/i.test(value)) return false;
	try {
		return new URL(value).protocol !== "file:";
	} catch {
		return false;
	}
}
function resolveHistoryImageContentType(media) {
	const contentType = normalizeOptionalString(media.contentType);
	if (contentType?.startsWith("image/")) return contentType;
	return mimeTypeFromFilePath(normalizeOptionalString(media.path));
}
function isHistoryImageMedia(media) {
	if (media.kind === "image") return true;
	return Boolean(resolveHistoryImageContentType(media)?.startsWith("image/"));
}
function resolveTimestamp(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function resolveHistoryEntries(ctx) {
	return Array.isArray(ctx.InboundHistory) ? ctx.InboundHistory : [];
}
function resolveRecentInboundHistoryImages(params) {
	const nowMs = params.nowMs ?? resolveTimestamp(params.ctx.Timestamp) ?? Date.now();
	const ttlMs = params.ttlMs ?? 18e5;
	const limit = Math.max(0, params.limit ?? 4);
	if (limit === 0) return [];
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const entries = resolveHistoryEntries(params.ctx);
	for (let index = entries.length - 1; index >= 0 && out.length < limit; index -= 1) {
		const entry = entries[index];
		const timestamp = resolveTimestamp(entry?.timestamp);
		if (timestamp === void 0 || Math.abs(nowMs - timestamp) > ttlMs) continue;
		const mediaEntries = Array.isArray(entry.media) ? entry.media : [];
		for (let mediaIndex = mediaEntries.length - 1; mediaIndex >= 0 && out.length < limit; mediaIndex -= 1) {
			const media = mediaEntries[mediaIndex];
			if (!media || !isHistoryImageMedia(media)) continue;
			const mediaPath = normalizeOptionalString(media.path);
			if (!mediaPath || isRemotePath(mediaPath)) continue;
			const contentType = resolveHistoryImageContentType(media);
			if (!contentType?.startsWith("image/")) continue;
			const messageId = normalizeOptionalString(media.messageId) ?? entry.messageId;
			const key = [messageId ?? "", mediaPath].join("\0");
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				path: mediaPath,
				contentType,
				sender: entry.sender,
				...messageId ? { messageId } : {}
			});
		}
	}
	return out.toReversed();
}
function appendRecentHistoryImageContext(params) {
	if (params.images.length === 0) return params.promptText;
	const notes = params.images.map((image, index) => {
		const message = image.messageId ? `, message ${image.messageId}` : "";
		return `[Recent image ${index + 1} from ${image.sender}${message}, attached as media.]`;
	});
	return [params.promptText, notes.join("\n")].filter((part) => part.trim().length > 0).join("\n\n");
}
//#endregion
//#region src/auto-reply/reply/inbound-media.ts
function hasNormalizedStringEntry(values) {
	return Array.isArray(values) && values.some((value) => normalizeOptionalString(value));
}
function hasInboundMedia(ctx) {
	return Boolean(ctx.StickerMediaIncluded || ctx.Sticker || normalizeOptionalString(ctx.MediaPath) || normalizeOptionalString(ctx.MediaUrl) || hasNormalizedStringEntry(ctx.MediaPaths) || hasNormalizedStringEntry(ctx.MediaUrls) || Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length > 0);
}
//#endregion
//#region src/auto-reply/reply/agent-turn-attachments.ts
const agentTurnMediaRuntimeLoader = createLazyImportLoader(() => import("./dispatch-acp-media.runtime.js"));
function loadAgentTurnMediaRuntime() {
	return agentTurnMediaRuntimeLoader.load();
}
const AGENT_TURN_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const AGENT_TURN_ATTACHMENT_TIMEOUT_MS = 1e3;
function isImageAgentTurnAttachment(attachment) {
	return attachment.mime?.startsWith("image/") === true;
}
function hasInboundHistoryMedia(ctx) {
	return Array.isArray(ctx.InboundHistory) && ctx.InboundHistory.some((entry) => Array.isArray(entry.media) && entry.media.length > 0);
}
async function resolveAgentTurnAttachments(params) {
	const includeRecentHistoryImages = params.includeRecentHistoryImages ?? true;
	if (!hasInboundMedia(params.ctx) && !(includeRecentHistoryImages && hasInboundHistoryMedia(params.ctx))) return {
		attachments: [],
		recentHistoryImages: []
	};
	const runtime = params.runtime ?? await loadAgentTurnMediaRuntime();
	const currentAttachments = runtime.normalizeAttachments(params.ctx).map((attachment) => normalizeOptionalString(attachment.path) ? Object.assign({}, attachment, { url: void 0 }) : attachment);
	const recentHistoryImages = includeRecentHistoryImages ? resolveRecentInboundHistoryImages({ ctx: params.ctx }) : [];
	const firstHistoryAttachmentIndex = currentAttachments.reduce((maxIndex, attachment) => Number.isFinite(attachment.index) ? Math.max(maxIndex, attachment.index) : maxIndex, -1) + 1;
	const historyAttachments = recentHistoryImages.map((image, index) => ({
		path: image.path,
		mime: image.contentType,
		index: firstHistoryAttachmentIndex + index
	}));
	const historyAttachmentByIndex = new Map(historyAttachments.map((attachment, index) => [attachment.index, recentHistoryImages[index]]));
	const mediaAttachments = [...currentAttachments, ...historyAttachments];
	const cache = new runtime.MediaAttachmentCache(mediaAttachments, { localPathRoots: runtime.resolveMediaAttachmentLocalRoots({
		cfg: params.cfg,
		ctx: params.ctx
	}) });
	const results = [];
	const resolvedHistoryImages = [];
	const resolveImageAttachment = async (attachment) => {
		const mediaType = attachment.mime ?? "application/octet-stream";
		if (!isImageAgentTurnAttachment(attachment)) return false;
		if (!normalizeOptionalString(attachment.path)) return false;
		try {
			const { buffer } = await cache.getBuffer({
				attachmentIndex: attachment.index,
				maxBytes: AGENT_TURN_ATTACHMENT_MAX_BYTES,
				timeoutMs: AGENT_TURN_ATTACHMENT_TIMEOUT_MS
			});
			results.push({
				mediaType,
				data: buffer.toString("base64")
			});
			const historyImage = historyAttachmentByIndex.get(attachment.index);
			if (historyImage) resolvedHistoryImages.push(historyImage);
			return true;
		} catch (error) {
			if (runtime.isMediaUnderstandingSkipError(error)) logVerbose(`agent-turn-attachments: skipping attachment #${attachment.index + 1} (${error.reason})`);
			else {
				const errorName = error instanceof Error ? error.name : typeof error;
				logVerbose(`agent-turn-attachments: failed to read attachment #${attachment.index + 1} (${errorName})`);
			}
			return false;
		}
	};
	let currentImageResolved = false;
	const hasCurrentMedia = currentAttachments.length > 0;
	const hasCurrentImageCandidate = currentAttachments.some(isImageAgentTurnAttachment);
	for (const attachment of currentAttachments) currentImageResolved = await resolveImageAttachment(attachment) || currentImageResolved;
	if (includeRecentHistoryImages && !currentImageResolved && (!hasCurrentMedia || hasCurrentImageCandidate)) for (const attachment of historyAttachments) await resolveImageAttachment(attachment);
	return {
		attachments: results,
		recentHistoryImages: resolvedHistoryImages
	};
}
function resolveInlineAgentImageAttachments(images) {
	if (!Array.isArray(images)) return [];
	return images.map((image) => ({
		mediaType: image.mimeType,
		data: image.data
	})).filter((image) => image.mediaType.startsWith("image/") && image.data.trim().length > 0);
}
//#endregion
//#region src/auto-reply/reply/block-reply-coalescer.ts
function createBlockReplyCoalescer(params) {
	const { config, shouldAbort, onFlush } = params;
	const minChars = Math.max(1, Math.floor(config.minChars));
	const maxChars = Math.max(minChars, Math.floor(config.maxChars));
	const idleMs = Math.max(0, Math.floor(config.idleMs));
	const joiner = config.joiner ?? "";
	const flushOnEnqueue = config.flushOnEnqueue === true;
	let bufferText = "";
	let bufferReplyToId;
	let bufferAudioAsVoice;
	let bufferIsReasoning;
	let bufferIsCompactionNotice;
	let bufferIsFallbackNotice;
	let idleTimer;
	const clearIdleTimer = () => {
		if (!idleTimer) return;
		clearTimeout(idleTimer);
		idleTimer = void 0;
	};
	const resetBuffer = () => {
		bufferText = "";
		bufferReplyToId = void 0;
		bufferAudioAsVoice = void 0;
		bufferIsReasoning = void 0;
		bufferIsCompactionNotice = void 0;
		bufferIsFallbackNotice = void 0;
	};
	const scheduleIdleFlush = () => {
		if (idleMs <= 0) return;
		clearIdleTimer();
		idleTimer = setTimeout(() => {
			flush({ force: false });
		}, idleMs);
	};
	const flush = async (options) => {
		clearIdleTimer();
		if (shouldAbort()) {
			resetBuffer();
			return;
		}
		if (!bufferText) return;
		if (!options?.force && !flushOnEnqueue && bufferText.length < minChars) {
			scheduleIdleFlush();
			return;
		}
		const payload = {
			text: bufferText,
			replyToId: bufferReplyToId,
			audioAsVoice: bufferAudioAsVoice,
			isReasoning: bufferIsReasoning,
			isCompactionNotice: bufferIsCompactionNotice,
			isFallbackNotice: bufferIsFallbackNotice
		};
		resetBuffer();
		await onFlush(payload);
	};
	const enqueue = (payload) => {
		if (shouldAbort()) return;
		const reply = resolveSendableOutboundReplyParts(payload);
		const hasMedia = reply.hasMedia;
		const text = reply.text;
		const hasText = reply.hasText;
		if (hasMedia) {
			flush({ force: true });
			onFlush(payload);
			return;
		}
		if (!hasText) return;
		if (flushOnEnqueue) {
			if (bufferText) flush({ force: true });
			bufferReplyToId = payload.replyToId;
			bufferAudioAsVoice = payload.audioAsVoice;
			bufferIsReasoning = payload.isReasoning;
			bufferIsCompactionNotice = payload.isCompactionNotice;
			bufferIsFallbackNotice = payload.isFallbackNotice;
			bufferText = text;
			flush({ force: true });
			return;
		}
		const replyToConflict = Boolean(bufferText && payload.replyToId && (!bufferReplyToId || bufferReplyToId !== payload.replyToId));
		const visibilityConflict = bufferText && (bufferIsReasoning !== payload.isReasoning || bufferIsCompactionNotice !== payload.isCompactionNotice || bufferIsFallbackNotice !== payload.isFallbackNotice);
		if (bufferText && (replyToConflict || bufferAudioAsVoice !== payload.audioAsVoice || visibilityConflict)) flush({ force: true });
		if (!bufferText) {
			bufferReplyToId = payload.replyToId;
			bufferAudioAsVoice = payload.audioAsVoice;
			bufferIsReasoning = payload.isReasoning;
			bufferIsCompactionNotice = payload.isCompactionNotice;
			bufferIsFallbackNotice = payload.isFallbackNotice;
		}
		const nextText = bufferText ? `${bufferText}${joiner}${text}` : text;
		if (nextText.length > maxChars) {
			if (bufferText) {
				flush({ force: true });
				bufferReplyToId = payload.replyToId;
				bufferAudioAsVoice = payload.audioAsVoice;
				bufferIsReasoning = payload.isReasoning;
				bufferIsCompactionNotice = payload.isCompactionNotice;
				bufferIsFallbackNotice = payload.isFallbackNotice;
				if (text.length >= maxChars) {
					onFlush(payload);
					return;
				}
				bufferText = text;
				scheduleIdleFlush();
				return;
			}
			onFlush(payload);
			return;
		}
		bufferText = nextText;
		if (bufferText.length >= maxChars) {
			flush({ force: true });
			return;
		}
		scheduleIdleFlush();
	};
	return {
		enqueue,
		flush,
		hasBuffered: () => Boolean(bufferText),
		stop: () => clearIdleTimer()
	};
}
//#endregion
//#region src/auto-reply/reply/block-reply-pipeline.ts
function createAudioAsVoiceBuffer(params) {
	let seenAudioAsVoice = false;
	return {
		onEnqueue: (payload) => {
			if (payload.audioAsVoice) seenAudioAsVoice = true;
		},
		shouldBuffer: (payload) => params.isAudioPayload(payload),
		finalize: (payload) => seenAudioAsVoice ? {
			...payload,
			audioAsVoice: true
		} : payload
	};
}
function createBlockReplyPayloadKey(payload) {
	const reply = resolveSendableOutboundReplyParts(payload);
	return JSON.stringify({
		text: reply.trimmedText,
		mediaList: reply.mediaUrls,
		presentation: payload.presentation ?? null,
		interactive: payload.interactive ?? null,
		channelData: payload.channelData ?? null,
		replyToId: payload.replyToId ?? null
	});
}
function createBlockReplyContentKey(payload) {
	const reply = resolveSendableOutboundReplyParts(payload);
	return JSON.stringify({
		text: reply.trimmedText,
		mediaList: reply.mediaUrls,
		presentation: payload.presentation ?? null,
		interactive: payload.interactive ?? null,
		channelData: payload.channelData ?? null
	});
}
const withTimeout = async (promise, timeoutMs, timeoutError) => {
	if (!timeoutMs || timeoutMs <= 0) return promise;
	let timer;
	const timeoutPromise = new Promise((_, reject) => {
		timer = setTimeout(() => reject(timeoutError), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};
function createBlockReplyPipeline(params) {
	const { onBlockReply, timeoutMs, coalescing, buffer } = params;
	const sentKeys = /* @__PURE__ */ new Set();
	const sentContentKeys = /* @__PURE__ */ new Set();
	const sentMediaUrls = /* @__PURE__ */ new Set();
	const pendingKeys = /* @__PURE__ */ new Set();
	const seenKeys = /* @__PURE__ */ new Set();
	const bufferedKeys = /* @__PURE__ */ new Set();
	const bufferedPayloadKeys = /* @__PURE__ */ new Set();
	const bufferedPayloads = [];
	const streamedTextFragments = [];
	let bufferedAssistantMessageIndex;
	let sendChain = Promise.resolve();
	let aborted = false;
	let didStream = false;
	let didLogTimeout = false;
	const hasSeenOrQueuedPayloadKey = (payloadKey) => seenKeys.has(payloadKey) || sentKeys.has(payloadKey) || pendingKeys.has(payloadKey);
	const flushBufferedAssistantBlock = () => {
		bufferedAssistantMessageIndex = void 0;
		coalescer?.flush({ force: true });
	};
	const sendPayload = (payload, bypassSeenCheck = false) => {
		if (aborted) return;
		const payloadKey = createBlockReplyPayloadKey(payload);
		const contentKey = createBlockReplyContentKey(payload);
		if (!bypassSeenCheck) {
			if (seenKeys.has(payloadKey)) return;
			seenKeys.add(payloadKey);
		}
		if (sentKeys.has(payloadKey) || pendingKeys.has(payloadKey)) return;
		pendingKeys.add(payloadKey);
		const timeoutError = /* @__PURE__ */ new Error(`block reply delivery timed out after ${timeoutMs}ms`);
		const abortController = new AbortController();
		sendChain = sendChain.then(async () => {
			if (aborted) return false;
			await withTimeout(Promise.resolve(onBlockReply(payload, {
				abortSignal: abortController.signal,
				timeoutMs
			})), timeoutMs, timeoutError);
			return true;
		}).then((didSend) => {
			if (!didSend) return;
			sentKeys.add(payloadKey);
			sentContentKeys.add(contentKey);
			const reply = resolveSendableOutboundReplyParts(payload);
			for (const mediaUrl of reply.mediaUrls) sentMediaUrls.add(mediaUrl);
			if (!reply.hasMedia && reply.trimmedText) streamedTextFragments.push(reply.trimmedText);
			didStream = true;
		}).catch((err) => {
			if (err === timeoutError) {
				abortController.abort();
				aborted = true;
				if (!didLogTimeout) {
					didLogTimeout = true;
					logVerbose(`block reply delivery timed out after ${timeoutMs}ms; skipping remaining block replies to preserve ordering`);
				}
				return;
			}
			logVerbose(`block reply delivery failed: ${String(err)}`);
		}).finally(() => {
			pendingKeys.delete(payloadKey);
		});
	};
	const coalescer = coalescing ? createBlockReplyCoalescer({
		config: coalescing,
		shouldAbort: () => aborted,
		onFlush: (payload) => {
			bufferedAssistantMessageIndex = void 0;
			bufferedKeys.clear();
			sendPayload(payload, true);
		}
	}) : null;
	const bufferPayload = (payload) => {
		buffer?.onEnqueue?.(payload);
		if (!buffer?.shouldBuffer(payload)) return false;
		const payloadKey = createBlockReplyPayloadKey(payload);
		if (hasSeenOrQueuedPayloadKey(payloadKey) || bufferedPayloadKeys.has(payloadKey)) return true;
		seenKeys.add(payloadKey);
		bufferedPayloadKeys.add(payloadKey);
		bufferedPayloads.push(payload);
		return true;
	};
	const flushBuffered = () => {
		if (!bufferedPayloads.length) return;
		for (const payload of bufferedPayloads) sendPayload(buffer?.finalize?.(payload) ?? payload, true);
		bufferedPayloads.length = 0;
		bufferedPayloadKeys.clear();
	};
	const enqueue = (payload) => {
		if (aborted) return;
		if (bufferPayload(payload)) return;
		const reply = resolveSendableOutboundReplyParts(payload);
		const hasNonTextContent = hasOutboundReplyContent({
			...payload,
			text: void 0
		}, { trimText: true });
		if (reply.hasMedia || hasNonTextContent) {
			coalescer?.flush({ force: true });
			sendPayload(payload, false);
			return;
		}
		if (coalescer) {
			const assistantMessageIndex = getReplyPayloadMetadata(payload)?.assistantMessageIndex;
			if (assistantMessageIndex !== void 0 && bufferedAssistantMessageIndex !== void 0 && assistantMessageIndex !== bufferedAssistantMessageIndex && coalescer.hasBuffered()) flushBufferedAssistantBlock();
			const payloadKey = createBlockReplyPayloadKey(payload);
			if (hasSeenOrQueuedPayloadKey(payloadKey) || bufferedKeys.has(payloadKey)) return;
			seenKeys.add(payloadKey);
			bufferedKeys.add(payloadKey);
			bufferedAssistantMessageIndex = assistantMessageIndex;
			coalescer.enqueue(payload);
			return;
		}
		sendPayload(payload, false);
	};
	const flush = async (options) => {
		await coalescer?.flush(options);
		bufferedAssistantMessageIndex = void 0;
		flushBuffered();
		await sendChain;
	};
	const stop = () => {
		coalescer?.stop();
	};
	return {
		enqueue,
		flush,
		stop,
		hasBuffered: () => coalescer?.hasBuffered() || bufferedPayloads.length > 0,
		didStream: () => didStream,
		isAborted: () => aborted,
		hasSentPayload: (payload) => {
			const payloadKey = createBlockReplyContentKey(payload);
			if (sentContentKeys.has(payloadKey)) return true;
			if (!didStream || streamedTextFragments.length === 0) return false;
			const reply = resolveSendableOutboundReplyParts(payload);
			if (reply.hasMedia || !reply.trimmedText) return false;
			const normalize = (text) => text.replace(/\s+/g, "");
			return normalize(streamedTextFragments.join("")) === normalize(reply.trimmedText);
		},
		getSentMediaUrls: () => Array.from(sentMediaUrls)
	};
}
//#endregion
export { resolveAgentTurnAttachments as a, appendRecentHistoryImageContext as c, loadAgentTurnMediaRuntime as i, createBlockReplyContentKey as n, resolveInlineAgentImageAttachments as o, createBlockReplyPipeline as r, hasInboundMedia as s, createAudioAsVoiceBuffer as t };
