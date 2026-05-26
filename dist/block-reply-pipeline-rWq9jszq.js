import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { i as getReplyPayloadMetadata, o as isReplyPayloadStatusNotice } from "./reply-payload-CiT5mlcY.js";
import { m as resolveSendableOutboundReplyParts, s as hasOutboundReplyContent } from "./reply-payload-DMPQsrQC.js";
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
	let bufferIsStatusNotice;
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
		bufferIsStatusNotice = void 0;
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
			isFallbackNotice: bufferIsFallbackNotice,
			isStatusNotice: bufferIsStatusNotice
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
			bufferIsStatusNotice = payload.isStatusNotice;
			bufferText = text;
			flush({ force: true });
			return;
		}
		const replyToConflict = Boolean(bufferText && payload.replyToId && (!bufferReplyToId || bufferReplyToId !== payload.replyToId));
		const visibilityConflict = bufferText && (bufferIsReasoning !== payload.isReasoning || bufferIsCompactionNotice !== payload.isCompactionNotice || bufferIsFallbackNotice !== payload.isFallbackNotice || isReplyPayloadStatusNotice({
			isCompactionNotice: bufferIsCompactionNotice,
			isFallbackNotice: bufferIsFallbackNotice,
			isStatusNotice: bufferIsStatusNotice
		}) !== isReplyPayloadStatusNotice(payload));
		if (bufferText && (replyToConflict || bufferAudioAsVoice !== payload.audioAsVoice || visibilityConflict)) flush({ force: true });
		if (!bufferText) {
			bufferReplyToId = payload.replyToId;
			bufferAudioAsVoice = payload.audioAsVoice;
			bufferIsReasoning = payload.isReasoning;
			bufferIsCompactionNotice = payload.isCompactionNotice;
			bufferIsFallbackNotice = payload.isFallbackNotice;
			bufferIsStatusNotice = payload.isStatusNotice;
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
				bufferIsStatusNotice = payload.isStatusNotice;
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
		statusNotice: isReplyPayloadStatusNotice(payload),
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
			const isStatusNotice = isReplyPayloadStatusNotice(payload);
			if (!isStatusNotice) sentContentKeys.add(contentKey);
			const reply = resolveSendableOutboundReplyParts(payload);
			for (const mediaUrl of reply.mediaUrls) sentMediaUrls.add(mediaUrl);
			if (!isStatusNotice && !reply.hasMedia && reply.trimmedText) streamedTextFragments.push(reply.trimmedText);
			if (!isStatusNotice) didStream = true;
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
export { createBlockReplyContentKey as n, createBlockReplyPipeline as r, createAudioAsVoiceBuffer as t };
