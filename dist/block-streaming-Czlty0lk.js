import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { a as normalizeChannelId, t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { t as resolveAccountEntry } from "./account-lookup-CQEoGO1F.js";
import { x as resolveChannelStreamingBlockCoalesce } from "./channel-streaming-BKIuGSWW.js";
import { c as resolveTextChunkLimit, s as resolveChunkMode } from "./chunk-IIklKK4Y.js";
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
export { resolveBlockStreamingChunking as n, resolveEffectiveBlockStreamingConfig as r, clampPositiveInteger as t };
