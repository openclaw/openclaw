import { _ as resolveStateDir } from "./paths-1qR_mW4i.js";
import { a as clampNumber, i as clampInt, y as resolveUserPath } from "./utils-Do8MzKyM.js";
import { i as resolveAgentConfig } from "./agent-scope-tkfLX5MZ.js";
import { a as isMemoryMultimodalEnabled, o as normalizeMemoryMultimodalSettings, s as supportsMemoryMultimodalEmbeddings } from "./multimodal-IUqnzBU8.js";
import path from "node:path";
import os from "node:os";
//#region src/agents/memory-search.ts
const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_GEMINI_MODEL = "gemini-embedding-001";
const DEFAULT_VOYAGE_MODEL = "voyage-4-large";
const DEFAULT_MISTRAL_MODEL = "mistral-embed";
const DEFAULT_OLLAMA_MODEL = "nomic-embed-text";
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
		if (source === "memory") {normalized.add("memory");}
		if (source === "sessions" && sessionMemoryEnabled) {normalized.add("sessions");}
	}
	if (normalized.size === 0) {normalized.add("memory");}
	return Array.from(normalized);
}
function resolveStorePath(agentId, raw) {
	const stateDir = resolveStateDir(process.env, os.homedir);
	const fallback = path.join(stateDir, "memory", `${agentId}.sqlite`);
	if (!raw) {return fallback;}
	return resolveUserPath(raw.includes("{agentId}") ? raw.replaceAll("{agentId}", agentId) : raw);
}
function mergeConfig(defaults, overrides, agentId) {
	const enabled = overrides?.enabled ?? defaults?.enabled ?? true;
	const sessionMemory = overrides?.experimental?.sessionMemory ?? defaults?.experimental?.sessionMemory ?? false;
	const provider = overrides?.provider ?? defaults?.provider ?? "auto";
	const defaultRemote = defaults?.remote;
	const overrideRemote = overrides?.remote;
	const includeRemote = Boolean(overrideRemote?.baseUrl || overrideRemote?.apiKey || overrideRemote?.headers || defaultRemote?.baseUrl || defaultRemote?.apiKey || defaultRemote?.headers) || provider === "openai" || provider === "gemini" || provider === "voyage" || provider === "mistral" || provider === "ollama" || provider === "auto";
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
		batch
	} : void 0;
	const fallback = overrides?.fallback ?? defaults?.fallback ?? "none";
	const modelDefault = provider === "gemini" ? DEFAULT_GEMINI_MODEL : provider === "openai" ? DEFAULT_OPENAI_MODEL : provider === "voyage" ? DEFAULT_VOYAGE_MODEL : provider === "mistral" ? DEFAULT_MISTRAL_MODEL : provider === "ollama" ? DEFAULT_OLLAMA_MODEL : void 0;
	const model = overrides?.model ?? defaults?.model ?? modelDefault ?? "";
	const outputDimensionality = overrides?.outputDimensionality ?? defaults?.outputDimensionality;
	const local = {
		modelPath: overrides?.local?.modelPath ?? defaults?.local?.modelPath,
		modelCacheDir: overrides?.local?.modelCacheDir ?? defaults?.local?.modelCacheDir
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
	const store = {
		driver: overrides?.store?.driver ?? defaults?.store?.driver ?? "sqlite",
		path: resolveStorePath(agentId, overrides?.store?.path ?? defaults?.store?.path),
		vector
	};
	const chunking = {
		tokens: overrides?.chunking?.tokens ?? defaults?.chunking?.tokens ?? DEFAULT_CHUNK_TOKENS,
		overlap: overrides?.chunking?.overlap ?? defaults?.chunking?.overlap ?? DEFAULT_CHUNK_OVERLAP
	};
	const sync = {
		onSessionStart: overrides?.sync?.onSessionStart ?? defaults?.sync?.onSessionStart ?? true,
		onSearch: overrides?.sync?.onSearch ?? defaults?.sync?.onSearch ?? true,
		watch: overrides?.sync?.watch ?? defaults?.sync?.watch ?? true,
		watchDebounceMs: overrides?.sync?.watchDebounceMs ?? defaults?.sync?.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS,
		intervalMinutes: overrides?.sync?.intervalMinutes ?? defaults?.sync?.intervalMinutes ?? 0,
		sessions: {
			deltaBytes: overrides?.sync?.sessions?.deltaBytes ?? defaults?.sync?.sessions?.deltaBytes ?? DEFAULT_SESSION_DELTA_BYTES,
			deltaMessages: overrides?.sync?.sessions?.deltaMessages ?? defaults?.sync?.sessions?.deltaMessages ?? DEFAULT_SESSION_DELTA_MESSAGES,
			postCompactionForce: overrides?.sync?.sessions?.postCompactionForce ?? defaults?.sync?.sessions?.postCompactionForce ?? true
		}
	};
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
				enabled: Boolean(hybrid.enabled),
				vectorWeight: normalizedVectorWeight,
				textWeight: normalizedTextWeight,
				candidateMultiplier,
				mmr: {
					enabled: Boolean(hybrid.mmr.enabled),
					lambda: Number.isFinite(hybrid.mmr.lambda) ? Math.max(0, Math.min(1, hybrid.mmr.lambda)) : DEFAULT_MMR_LAMBDA
				},
				temporalDecay: {
					enabled: Boolean(hybrid.temporalDecay.enabled),
					halfLifeDays: temporalDecayHalfLifeDays
				}
			}
		},
		cache: {
			enabled: Boolean(cache.enabled),
			maxEntries: typeof cache.maxEntries === "number" && Number.isFinite(cache.maxEntries) ? Math.max(1, Math.floor(cache.maxEntries)) : void 0
		}
	};
}
function resolveMemorySearchConfig(cfg, agentId) {
	const defaults = cfg.agents?.defaults?.memorySearch;
	const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
	const resolved = mergeConfig(defaults, overrides, agentId);
	if (!resolved.enabled) {return null;}
	const multimodalActive = isMemoryMultimodalEnabled(resolved.multimodal);
	if (multimodalActive && !supportsMemoryMultimodalEmbeddings({
		provider: resolved.provider,
		model: resolved.model
	})) {throw new Error("agents.*.memorySearch.multimodal requires memorySearch.provider = \"gemini\" and model = \"gemini-embedding-2-preview\".");}
	if (multimodalActive && resolved.fallback !== "none") {throw new Error("agents.*.memorySearch.multimodal does not support memorySearch.fallback. Set fallback to \"none\".");}
	return resolved;
}
//#endregion
export { resolveMemorySearchConfig as t };
