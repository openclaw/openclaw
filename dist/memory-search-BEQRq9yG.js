import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as clampNumber, p as resolveUserPath, r as clampInt } from "./utils-sBTEdeml.js";
import { n as findNormalizedProviderValue, r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import "./agent-scope-CtLXGcWm.js";
import { r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { n as getMemoryEmbeddingProvider } from "./memory-embedding-providers-816TTVuI.js";
import { a as isMemoryMultimodalEnabled, o as normalizeMemoryMultimodalSettings } from "./multimodal-DsKQmW5D.js";
import path from "node:path";
import os from "node:os";
//#region src/agents/memory-search.ts
const DEFAULT_CHUNK_TOKENS = 400;
const DEFAULT_CHUNK_OVERLAP = 80;
const DEFAULT_WATCH_DEBOUNCE_MS = 1500;
const DEFAULT_SESSION_DELTA_BYTES = 1e5;
const DEFAULT_SESSION_DELTA_MESSAGES = 50;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = .35;
const DEFAULT_HYBRID_ENABLED = true;
const DEFAULT_HYBRID_VECTOR_WEIGHT = .7;
const DEFAULT_HYBRID_TEXT_WEIGHT = .3;
const DEFAULT_HYBRID_CANDIDATE_MULTIPLIER = 4;
const DEFAULT_MMR_ENABLED = false;
const DEFAULT_MMR_LAMBDA = .7;
const DEFAULT_TEMPORAL_DECAY_ENABLED = false;
const DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS = 30;
const DEFAULT_CACHE_ENABLED = true;
const DEFAULT_SOURCES = ["memory"];
function normalizeSources(sources, sessionMemoryEnabled) {
	const normalized = /* @__PURE__ */ new Set();
	const input = sources?.length ? sources : DEFAULT_SOURCES;
	for (const source of input) {
		if (source === "memory") normalized.add("memory");
		if (source === "sessions" && sessionMemoryEnabled) normalized.add("sessions");
	}
	if (normalized.size === 0) normalized.add("memory");
	return Array.from(normalized);
}
function resolveStorePath(agentId, raw) {
	const stateDir = resolveStateDir(process.env, os.homedir);
	const fallback = path.join(stateDir, "memory", `${agentId}.sqlite`);
	if (!raw) return fallback;
	return resolveUserPath(raw.includes("{agentId}") ? raw.replaceAll("{agentId}", agentId) : raw);
}
function getConfiguredMemoryEmbeddingProvider(providerId, cfg) {
	const directAdapter = getMemoryEmbeddingProvider(providerId);
	if (directAdapter) return directAdapter;
	const ownerApi = findNormalizedProviderValue(cfg.models?.providers, providerId)?.api?.trim();
	if (!ownerApi) return;
	const normalizedProvider = normalizeProviderId(providerId);
	const normalizedOwner = normalizeProviderId(ownerApi);
	if (!normalizedOwner || normalizedOwner === normalizedProvider) return;
	return getMemoryEmbeddingProvider(normalizedOwner);
}
function mergeConfig(cfg, defaults, overrides, agentId) {
	const enabled = overrides?.enabled ?? defaults?.enabled ?? true;
	const sessionMemory = overrides?.experimental?.sessionMemory ?? defaults?.experimental?.sessionMemory ?? false;
	const provider = overrides?.provider ?? defaults?.provider ?? "auto";
	const primaryAdapter = provider === "auto" ? void 0 : getConfiguredMemoryEmbeddingProvider(provider, cfg);
	const defaultRemote = defaults?.remote;
	const overrideRemote = overrides?.remote;
	const fallback = overrides?.fallback ?? defaults?.fallback ?? "none";
	const fallbackAdapter = fallback && fallback !== "none" ? getConfiguredMemoryEmbeddingProvider(fallback, cfg) : void 0;
	const includeRemote = Boolean(overrideRemote?.baseUrl || overrideRemote?.apiKey || overrideRemote?.headers || overrideRemote?.nonBatchConcurrency != null || defaultRemote?.baseUrl || defaultRemote?.apiKey || defaultRemote?.headers || defaultRemote?.nonBatchConcurrency != null) || provider === "auto" || primaryAdapter?.transport !== "local" || fallbackAdapter?.transport === "remote";
	const batch = {
		enabled: overrideRemote?.batch?.enabled ?? defaultRemote?.batch?.enabled ?? false,
		wait: overrideRemote?.batch?.wait ?? defaultRemote?.batch?.wait ?? true,
		concurrency: Math.max(1, overrideRemote?.batch?.concurrency ?? defaultRemote?.batch?.concurrency ?? 2),
		pollIntervalMs: overrideRemote?.batch?.pollIntervalMs ?? defaultRemote?.batch?.pollIntervalMs ?? 2e3,
		timeoutMinutes: overrideRemote?.batch?.timeoutMinutes ?? defaultRemote?.batch?.timeoutMinutes ?? 60
	};
	const remote = includeRemote ? {
		baseUrl: overrideRemote?.baseUrl ?? defaultRemote?.baseUrl,
		apiKey: overrideRemote?.apiKey ?? defaultRemote?.apiKey,
		headers: overrideRemote?.headers ?? defaultRemote?.headers,
		nonBatchConcurrency: overrideRemote?.nonBatchConcurrency ?? defaultRemote?.nonBatchConcurrency,
		batch
	} : void 0;
	const modelDefault = provider === "auto" ? void 0 : primaryAdapter?.defaultModel;
	const model = overrides?.model ?? defaults?.model ?? modelDefault ?? "";
	const inputType = overrides?.inputType?.trim() || defaults?.inputType?.trim() || void 0;
	const queryInputType = overrides?.queryInputType?.trim() || defaults?.queryInputType?.trim() || void 0;
	const documentInputType = overrides?.documentInputType?.trim() || defaults?.documentInputType?.trim() || void 0;
	const outputDimensionality = overrides?.outputDimensionality ?? defaults?.outputDimensionality;
	const local = {
		modelPath: overrides?.local?.modelPath ?? defaults?.local?.modelPath,
		modelCacheDir: overrides?.local?.modelCacheDir ?? defaults?.local?.modelCacheDir,
		contextSize: overrides?.local?.contextSize ?? defaults?.local?.contextSize
	};
	const sources = normalizeSources(overrides?.sources ?? defaults?.sources, sessionMemory);
	const rawPaths = [...defaults?.extraPaths ?? [], ...overrides?.extraPaths ?? []].map((value) => value.trim()).filter(Boolean);
	const extraPaths = Array.from(new Set(rawPaths));
	const multimodal = normalizeMemoryMultimodalSettings({
		enabled: overrides?.multimodal?.enabled ?? defaults?.multimodal?.enabled,
		modalities: overrides?.multimodal?.modalities ?? defaults?.multimodal?.modalities,
		maxFileBytes: overrides?.multimodal?.maxFileBytes ?? defaults?.multimodal?.maxFileBytes
	});
	const vector = {
		enabled: overrides?.store?.vector?.enabled ?? defaults?.store?.vector?.enabled ?? true,
		extensionPath: overrides?.store?.vector?.extensionPath ?? defaults?.store?.vector?.extensionPath
	};
	const fts = { tokenizer: overrides?.store?.fts?.tokenizer ?? defaults?.store?.fts?.tokenizer ?? "unicode61" };
	const store = {
		driver: overrides?.store?.driver ?? defaults?.store?.driver ?? "sqlite",
		path: resolveStorePath(agentId, overrides?.store?.path ?? defaults?.store?.path),
		fts,
		vector
	};
	const chunking = {
		tokens: overrides?.chunking?.tokens ?? defaults?.chunking?.tokens ?? DEFAULT_CHUNK_TOKENS,
		overlap: overrides?.chunking?.overlap ?? defaults?.chunking?.overlap ?? DEFAULT_CHUNK_OVERLAP
	};
	const sync = resolveSyncConfig(defaults, overrides);
	const query = {
		maxResults: overrides?.query?.maxResults ?? defaults?.query?.maxResults ?? DEFAULT_MAX_RESULTS,
		minScore: overrides?.query?.minScore ?? defaults?.query?.minScore ?? DEFAULT_MIN_SCORE
	};
	const hybrid = {
		enabled: overrides?.query?.hybrid?.enabled ?? defaults?.query?.hybrid?.enabled ?? DEFAULT_HYBRID_ENABLED,
		vectorWeight: overrides?.query?.hybrid?.vectorWeight ?? defaults?.query?.hybrid?.vectorWeight ?? DEFAULT_HYBRID_VECTOR_WEIGHT,
		textWeight: overrides?.query?.hybrid?.textWeight ?? defaults?.query?.hybrid?.textWeight ?? DEFAULT_HYBRID_TEXT_WEIGHT,
		candidateMultiplier: overrides?.query?.hybrid?.candidateMultiplier ?? defaults?.query?.hybrid?.candidateMultiplier ?? DEFAULT_HYBRID_CANDIDATE_MULTIPLIER,
		mmr: {
			enabled: overrides?.query?.hybrid?.mmr?.enabled ?? defaults?.query?.hybrid?.mmr?.enabled ?? DEFAULT_MMR_ENABLED,
			lambda: overrides?.query?.hybrid?.mmr?.lambda ?? defaults?.query?.hybrid?.mmr?.lambda ?? DEFAULT_MMR_LAMBDA
		},
		temporalDecay: {
			enabled: overrides?.query?.hybrid?.temporalDecay?.enabled ?? defaults?.query?.hybrid?.temporalDecay?.enabled ?? DEFAULT_TEMPORAL_DECAY_ENABLED,
			halfLifeDays: overrides?.query?.hybrid?.temporalDecay?.halfLifeDays ?? defaults?.query?.hybrid?.temporalDecay?.halfLifeDays ?? DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS
		}
	};
	const cache = {
		enabled: overrides?.cache?.enabled ?? defaults?.cache?.enabled ?? DEFAULT_CACHE_ENABLED,
		maxEntries: overrides?.cache?.maxEntries ?? defaults?.cache?.maxEntries
	};
	const overlap = clampNumber(chunking.overlap, 0, Math.max(0, chunking.tokens - 1));
	const minScore = clampNumber(query.minScore, 0, 1);
	const vectorWeight = clampNumber(hybrid.vectorWeight, 0, 1);
	const textWeight = clampNumber(hybrid.textWeight, 0, 1);
	const sum = vectorWeight + textWeight;
	const normalizedVectorWeight = sum > 0 ? vectorWeight / sum : DEFAULT_HYBRID_VECTOR_WEIGHT;
	const normalizedTextWeight = sum > 0 ? textWeight / sum : DEFAULT_HYBRID_TEXT_WEIGHT;
	const candidateMultiplier = clampInt(hybrid.candidateMultiplier, 1, 20);
	const temporalDecayHalfLifeDays = Math.max(1, Math.floor(Number.isFinite(hybrid.temporalDecay.halfLifeDays) ? hybrid.temporalDecay.halfLifeDays : DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS));
	const deltaBytes = clampInt(sync.sessions.deltaBytes, 0, Number.MAX_SAFE_INTEGER);
	const deltaMessages = clampInt(sync.sessions.deltaMessages, 0, Number.MAX_SAFE_INTEGER);
	const postCompactionForce = sync.sessions.postCompactionForce;
	return {
		enabled,
		sources,
		extraPaths,
		multimodal,
		provider,
		remote,
		experimental: { sessionMemory },
		fallback,
		model,
		inputType,
		queryInputType,
		documentInputType,
		outputDimensionality,
		local,
		store,
		chunking: {
			tokens: Math.max(1, chunking.tokens),
			overlap
		},
		sync: {
			...sync,
			sessions: {
				deltaBytes,
				deltaMessages,
				postCompactionForce
			}
		},
		query: {
			...query,
			minScore,
			hybrid: {
				enabled: hybrid.enabled,
				vectorWeight: normalizedVectorWeight,
				textWeight: normalizedTextWeight,
				candidateMultiplier,
				mmr: {
					enabled: hybrid.mmr.enabled,
					lambda: Number.isFinite(hybrid.mmr.lambda) ? Math.max(0, Math.min(1, hybrid.mmr.lambda)) : DEFAULT_MMR_LAMBDA
				},
				temporalDecay: {
					enabled: hybrid.temporalDecay.enabled,
					halfLifeDays: temporalDecayHalfLifeDays
				}
			}
		},
		cache: {
			enabled: cache.enabled,
			maxEntries: typeof cache.maxEntries === "number" && Number.isFinite(cache.maxEntries) ? Math.max(1, Math.floor(cache.maxEntries)) : void 0
		}
	};
}
function resolveSyncConfig(defaults, overrides) {
	return {
		onSessionStart: overrides?.sync?.onSessionStart ?? defaults?.sync?.onSessionStart ?? true,
		onSearch: overrides?.sync?.onSearch ?? defaults?.sync?.onSearch ?? true,
		watch: overrides?.sync?.watch ?? defaults?.sync?.watch ?? true,
		watchDebounceMs: overrides?.sync?.watchDebounceMs ?? defaults?.sync?.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS,
		intervalMinutes: overrides?.sync?.intervalMinutes ?? defaults?.sync?.intervalMinutes ?? 0,
		embeddingBatchTimeoutSeconds: overrides?.sync?.embeddingBatchTimeoutSeconds ?? defaults?.sync?.embeddingBatchTimeoutSeconds,
		sessions: {
			deltaBytes: overrides?.sync?.sessions?.deltaBytes ?? defaults?.sync?.sessions?.deltaBytes ?? DEFAULT_SESSION_DELTA_BYTES,
			deltaMessages: overrides?.sync?.sessions?.deltaMessages ?? defaults?.sync?.sessions?.deltaMessages ?? DEFAULT_SESSION_DELTA_MESSAGES,
			postCompactionForce: overrides?.sync?.sessions?.postCompactionForce ?? defaults?.sync?.sessions?.postCompactionForce ?? true
		}
	};
}
function resolveMemorySearchConfig(cfg, agentId) {
	const defaults = cfg.agents?.defaults?.memorySearch;
	const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
	const resolved = mergeConfig(cfg, defaults, overrides, agentId);
	if (!resolved.enabled) return null;
	const multimodalActive = isMemoryMultimodalEnabled(resolved.multimodal);
	const multimodalProvider = resolved.provider === "auto" ? void 0 : getConfiguredMemoryEmbeddingProvider(resolved.provider, cfg);
	if (multimodalActive && multimodalProvider && !(multimodalProvider.supportsMultimodalEmbeddings?.({ model: resolved.model }) ?? false)) throw new Error("agents.*.memorySearch.multimodal requires a provider adapter that supports multimodal embeddings for the configured model.");
	if (multimodalActive && resolved.fallback !== "none") throw new Error("agents.*.memorySearch.multimodal does not support memorySearch.fallback. Set fallback to \"none\".");
	return resolved;
}
function resolveMemorySearchSyncConfig(cfg, agentId) {
	const defaults = cfg.agents?.defaults?.memorySearch;
	const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
	if (!(overrides?.enabled ?? defaults?.enabled ?? true)) return null;
	return resolveSyncConfig(defaults, overrides);
}
//#endregion
export { resolveMemorySearchSyncConfig as n, resolveMemorySearchConfig as t };
