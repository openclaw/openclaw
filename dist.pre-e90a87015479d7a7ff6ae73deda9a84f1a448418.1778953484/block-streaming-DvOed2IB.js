import { n as normalizeAccountId } from "./account-id-CwBWagLE.js";
import { r as logVerbose } from "./globals-BjBVXBcN.js";
import { t as resolveAccountEntry } from "./account-lookup-wnmY2gpl.js";
import { u as normalizeMessageChannel } from "./message-channel-Ch_vVUeC.js";
import { a as normalizeChannelId, t as getChannelPlugin } from "./registry-Dapwkxqy2.js";
import "./plugins-xyXSVvnh.js";
import { n as getReplyPayloadMetadata } from "./reply-payload-BCYeCEKu.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-GL3-wijr.js";
import { _ as resolveChannelStreamingBlockCoalesce } from "./channel-streaming-DJqJ584R.js";
import { c as resolveTextChunkLimit, s as resolveChunkMode } from "./chunk-DZwoFz2Z.js";
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
			isCompactionNotice: bufferIsCompactionNotice
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
			bufferText = text;
			flush({ force: true });
			return;
		}
		const replyToConflict = Boolean(bufferText && payload.replyToId && (!bufferReplyToId || bufferReplyToId !== payload.replyToId));
		const visibilityConflict = bufferText && (bufferIsReasoning !== payload.isReasoning || bufferIsCompactionNotice !== payload.isCompactionNotice);
		if (bufferText && (replyToConflict || bufferAudioAsVoice !== payload.audioAsVoice || visibilityConflict)) flush({ force: true });
		if (!bufferText) {
			bufferReplyToId = payload.replyToId;
			bufferAudioAsVoice = payload.audioAsVoice;
			bufferIsReasoning = payload.isReasoning;
			bufferIsCompactionNotice = payload.isCompactionNotice;
		}
		const nextText = bufferText ? `${bufferText}${joiner}${text}` : text;
		if (nextText.length > maxChars) {
			if (bufferText) {
				flush({ force: true });
				bufferReplyToId = payload.replyToId;
				bufferAudioAsVoice = payload.audioAsVoice;
				bufferIsReasoning = payload.isReasoning;
				bufferIsCompactionNotice = payload.isCompactionNotice;
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
		replyToId: payload.replyToId ?? null
	});
}
function createBlockReplyContentKey(payload) {
	const reply = resolveSendableOutboundReplyParts(payload);
	return JSON.stringify({
		text: reply.trimmedText,
		mediaList: reply.mediaUrls
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
		if (resolveSendableOutboundReplyParts(payload).hasMedia) {
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
//#region src/auto-reply/reply/block-streaming.ts
const DEFAULT_BLOCK_STREAM_MIN = 800;
const DEFAULT_BLOCK_STREAM_MAX = 1200;
const DEFAULT_BLOCK_STREAM_COALESCE_IDLE_MS = 1e3;
function resolveProviderChunkContext(cfg, provider, accountId) {
	const providerKey = provider ? normalizeMessageChannel(provider) : void 0;
	const providerId = providerKey ? normalizeChannelId(providerKey) : null;
	return {
		providerKey,
		providerId,
		textLimit: resolveTextChunkLimit(cfg, providerKey, accountId, { fallbackLimit: providerId ? getChannelPlugin(providerId)?.outbound?.textChunkLimit : void 0 })
	};
}
function resolveProviderBlockStreamingCoalesce(params) {
	const { cfg, providerKey, accountId } = params;
	if (!cfg || !providerKey) return;
	const providerCfg = cfg[providerKey];
	if (!providerCfg || typeof providerCfg !== "object") return;
	const normalizedAccountId = normalizeAccountId(accountId);
	const typed = providerCfg;
	const accountCfg = resolveAccountEntry(typed.accounts, normalizedAccountId);
	return resolveChannelStreamingBlockCoalesce(accountCfg) ?? resolveChannelStreamingBlockCoalesce(typed) ?? accountCfg?.blockStreamingCoalesce ?? typed.blockStreamingCoalesce;
}
function clampPositiveInteger(value, fallback, bounds) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.round(value);
	if (rounded < bounds.min) return bounds.min;
	if (rounded > bounds.max) return bounds.max;
	return rounded;
}
function resolveEffectiveBlockStreamingConfig(params) {
	const { textLimit } = resolveProviderChunkContext(params.cfg, params.provider, params.accountId);
	const chunkingDefaults = params.chunking ?? resolveBlockStreamingChunking(params.cfg, params.provider, params.accountId);
	const chunkingMax = clampPositiveInteger(params.maxChunkChars, chunkingDefaults.maxChars, {
		min: 1,
		max: Math.max(1, textLimit)
	});
	const chunking = {
		...chunkingDefaults,
		minChars: Math.min(chunkingDefaults.minChars, chunkingMax),
		maxChars: chunkingMax
	};
	const coalescingDefaults = resolveBlockStreamingCoalescing(params.cfg, params.provider, params.accountId, chunking);
	const coalescingMax = Math.max(1, Math.min(coalescingDefaults?.maxChars ?? chunking.maxChars, chunking.maxChars));
	return {
		chunking,
		coalescing: {
			minChars: Math.min(coalescingDefaults?.minChars ?? chunking.minChars, coalescingMax),
			maxChars: coalescingMax,
			idleMs: clampPositiveInteger(params.coalesceIdleMs, coalescingDefaults?.idleMs ?? DEFAULT_BLOCK_STREAM_COALESCE_IDLE_MS, {
				min: 0,
				max: 5e3
			}),
			joiner: coalescingDefaults?.joiner ?? (chunking.breakPreference === "sentence" ? " " : chunking.breakPreference === "newline" ? "\n" : "\n\n"),
			...coalescingDefaults?.flushOnEnqueue === true ? { flushOnEnqueue: true } : {}
		}
	};
}
function resolveBlockStreamingChunking(cfg, provider, accountId) {
	const { providerKey, textLimit } = resolveProviderChunkContext(cfg, provider, accountId);
	const chunkCfg = cfg?.agents?.defaults?.blockStreamingChunk;
	const chunkMode = resolveChunkMode(cfg, providerKey, accountId);
	const maxRequested = Math.max(1, Math.floor(chunkCfg?.maxChars ?? DEFAULT_BLOCK_STREAM_MAX));
	const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
	const minFallback = DEFAULT_BLOCK_STREAM_MIN;
	const minRequested = Math.max(1, Math.floor(chunkCfg?.minChars ?? minFallback));
	return {
		minChars: Math.min(minRequested, maxChars),
		maxChars,
		breakPreference: chunkCfg?.breakPreference === "newline" || chunkCfg?.breakPreference === "sentence" ? chunkCfg.breakPreference : "paragraph",
		flushOnParagraph: chunkMode === "newline"
	};
}
function resolveBlockStreamingCoalescing(cfg, provider, accountId, chunking) {
	const { providerKey, providerId, textLimit } = resolveProviderChunkContext(cfg, provider, accountId);
	const providerDefaults = providerId ? getChannelPlugin(providerId)?.streaming?.blockStreamingCoalesceDefaults : void 0;
	const coalesceCfg = resolveProviderBlockStreamingCoalesce({
		cfg,
		providerKey,
		accountId
	}) ?? cfg?.agents?.defaults?.blockStreamingCoalesce;
	const minRequested = Math.max(1, Math.floor(coalesceCfg?.minChars ?? providerDefaults?.minChars ?? chunking?.minChars ?? DEFAULT_BLOCK_STREAM_MIN));
	const maxRequested = Math.max(1, Math.floor(coalesceCfg?.maxChars ?? textLimit));
	const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
	const minChars = Math.min(minRequested, maxChars);
	const idleMs = Math.max(0, Math.floor(coalesceCfg?.idleMs ?? providerDefaults?.idleMs ?? DEFAULT_BLOCK_STREAM_COALESCE_IDLE_MS));
	const preference = chunking?.breakPreference ?? "paragraph";
	return {
		minChars,
		maxChars,
		idleMs,
		joiner: preference === "sentence" ? " " : preference === "newline" ? "\n" : "\n\n"
	};
}
//#endregion
export { createBlockReplyContentKey as a, createAudioAsVoiceBuffer as i, resolveBlockStreamingChunking as n, createBlockReplyPipeline as o, resolveEffectiveBlockStreamingConfig as r, clampPositiveInteger as t };
