import os from "node:os";
import path from "node:path";
import type { ChunkingConfig, ChunkingStrategyName } from "../memory-host-sdk/host/chunking/types.js";
import {
  DEFAULT_CHUNK_TOKENS, DEFAULT_CHUNK_OVERLAP,
  DEFAULT_MAX_DEPTH, DEFAULT_MAX_TOKENS,
  DEFAULT_TARGET_TOKENS, DEFAULT_OVERLAP_SENTENCES,
  DEFAULT_BUFFER_SIZE, DEFAULT_BREAKPOINT_PERCENTILE_THRESHOLD,
  DEFAULT_LUMBER_THETA,
  DEFAULT_WINDOW_SIZE, DEFAULT_LINE_MAX_LEN, DEFAULT_MAX_LEVEL, DEFAULT_RECURRENT_TYPE,
} from "../memory-host-sdk/host/chunking/index.js";
import type { OpenClawConfig, MemorySearchConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { SecretInput } from "../config/types.secrets.js";
import {
  isMemoryMultimodalEnabled,
  normalizeMemoryMultimodalSettings,
  type MemoryMultimodalSettings,
} from "../memory-host-sdk/multimodal.js";
import { getMemoryEmbeddingProvider } from "../plugins/memory-embedding-providers.js";
import { clampInt, clampNumber, resolveUserPath } from "../utils.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type ResolvedMemorySearchConfig = {
  enabled: boolean;
  sources: Array<"memory" | "sessions">;
  extraPaths: string[];
  multimodal: MemoryMultimodalSettings;
  provider: string;
  remote?: {
    baseUrl?: string;
    apiKey?: SecretInput;
    headers?: Record<string, string>;
    nonBatchConcurrency?: number;
    batch?: {
      enabled: boolean;
      wait: boolean;
      concurrency: number;
      pollIntervalMs: number;
      timeoutMinutes: number;
    };
  };
  experimental: {
    sessionMemory: boolean;
  };
  fallback: string;
  model: string;
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
  outputDimensionality?: number;
  local: {
    modelPath?: string;
    modelCacheDir?: string;
    contextSize?: number | "auto";
  };
  store: {
    driver: "sqlite";
    path: string;
    fts: {
      tokenizer: "unicode61" | "trigram";
    };
    vector: {
      enabled: boolean;
      extensionPath?: string;
    };
  };
  chunking: ChunkingConfig;
  sync: {
    onSessionStart: boolean;
    onSearch: boolean;
    watch: boolean;
    watchDebounceMs: number;
    intervalMinutes: number;
    embeddingBatchTimeoutSeconds: number | undefined;
    sessions: {
      deltaBytes: number;
      deltaMessages: number;
      postCompactionForce: boolean;
    };
  };
  query: {
    maxResults: number;
    minScore: number;
    hybrid: {
      enabled: boolean;
      vectorWeight: number;
      textWeight: number;
      candidateMultiplier: number;
      mmr: {
        enabled: boolean;
        lambda: number;
      };
      temporalDecay: {
        enabled: boolean;
        halfLifeDays: number;
      };
    };
  };
  cache: {
    enabled: boolean;
    maxEntries?: number;
  };
};

export type ResolvedMemorySearchSyncConfig = ResolvedMemorySearchConfig["sync"];

const DEFAULT_WATCH_DEBOUNCE_MS = 1500;
const DEFAULT_SESSION_DELTA_BYTES = 100_000;
const DEFAULT_SESSION_DELTA_MESSAGES = 50;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.35;
const DEFAULT_HYBRID_ENABLED = true;
const DEFAULT_HYBRID_VECTOR_WEIGHT = 0.7;
const DEFAULT_HYBRID_TEXT_WEIGHT = 0.3;
const DEFAULT_HYBRID_CANDIDATE_MULTIPLIER = 4;
const DEFAULT_MMR_ENABLED = false;
const DEFAULT_MMR_LAMBDA = 0.7;
const DEFAULT_TEMPORAL_DECAY_ENABLED = false;
const DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS = 30;
const DEFAULT_CACHE_ENABLED = true;
const DEFAULT_SOURCES: Array<"memory" | "sessions"> = ["memory"];

/**
 * Resolve the chunking config into a fully typed discriminated union,
 * applying defaults per strategy and clamping values.
 */
export function resolveChunkingConfig(
  strategy: ChunkingStrategyName,
  overrides?: MemorySearchConfig["chunking"],
  defaults?: MemorySearchConfig["chunking"],
): ChunkingConfig {
  switch (strategy) {
    case "markdown-heading": {
      const maxDepth = clampInt(
        overrides?.maxDepth ?? defaults?.maxDepth ?? DEFAULT_MAX_DEPTH,
        1,
        6,
      );
      const maxTokens = Math.max(
        1,
        overrides?.maxTokens ?? defaults?.maxTokens ?? DEFAULT_MAX_TOKENS,
      );
      return { strategy: "markdown-heading", maxDepth, maxTokens };
    }
    case "sentence": {
      const targetTokens = Math.max(
        1,
        overrides?.targetTokens ?? defaults?.targetTokens ?? DEFAULT_TARGET_TOKENS,
      );
      const overlapSentences = Math.max(
        0,
        overrides?.overlapSentences ?? defaults?.overlapSentences ?? DEFAULT_OVERLAP_SENTENCES,
      );
      return { strategy: "sentence", targetTokens, overlapSentences };
    }
    case "semantic": {
      const bufferSize = overrides?.bufferSize ?? defaults?.bufferSize ?? DEFAULT_BUFFER_SIZE;
      const breakpointPercentileThreshold = overrides?.breakpointPercentileThreshold ?? defaults?.breakpointPercentileThreshold ?? DEFAULT_BREAKPOINT_PERCENTILE_THRESHOLD;
      return { strategy: "semantic", bufferSize, breakpointPercentileThreshold };
    }
    case "lumber": {
      const theta = Math.max(1, overrides?.theta ?? defaults?.theta ?? DEFAULT_LUMBER_THETA);
      const completionModel = overrides?.completionModel ?? defaults?.completionModel;
      if (!completionModel) {
        throw new Error(
          "must specify agents.defaults.memorySearch.chunking.completionModel when using lumber chunking."
        );
      }
      return { strategy: "lumber", theta, completionModel };
    }
    case "hichunk": {
      const windowSize = Math.max(1, overrides?.windowSize ?? defaults?.windowSize ?? DEFAULT_WINDOW_SIZE);
      const lineMaxLen = Math.max(1, overrides?.lineMaxLen ?? defaults?.lineMaxLen ?? DEFAULT_LINE_MAX_LEN);
      const maxLevel = clampInt(overrides?.maxLevel ?? defaults?.maxLevel ?? DEFAULT_MAX_LEVEL, 1, 10);
      const recurrentType = overrides?.recurrentType ?? defaults?.recurrentType ?? DEFAULT_RECURRENT_TYPE;
      const completionModel = overrides?.completionModel ?? defaults?.completionModel;
      if (!completionModel) {
        throw new Error(
          "must specify agents.defaults.memorySearch.chunking.completionModel when using hichunk chunking."
        );
      }
      return { strategy: "hichunk", windowSize, lineMaxLen, maxLevel, recurrentType, completionModel };
    }
    case "fixed-size":
    default: {
      const tokens = Math.max(
        1,
        overrides?.tokens ?? defaults?.tokens ?? DEFAULT_CHUNK_TOKENS,
      );
      const overlap = clampNumber(
        overrides?.overlap ?? defaults?.overlap ?? DEFAULT_CHUNK_OVERLAP,
        0,
        Math.max(0, tokens - 1),
      );
      return { strategy: "fixed-size", tokens, overlap };
    }
  }
}

function normalizeSources(
  sources: Array<"memory" | "sessions"> | undefined,
  sessionMemoryEnabled: boolean,
): Array<"memory" | "sessions"> {
  const normalized = new Set<"memory" | "sessions">();
  const input = sources?.length ? sources : DEFAULT_SOURCES;
  for (const source of input) {
    if (source === "memory") {
      normalized.add("memory");
    }
    if (source === "sessions" && sessionMemoryEnabled) {
      normalized.add("sessions");
    }
  }
  if (normalized.size === 0) {
    normalized.add("memory");
  }
  return Array.from(normalized);
}

function resolveStorePath(agentId: string, raw?: string): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  const fallback = path.join(stateDir, "memory", `${agentId}.sqlite`);
  if (!raw) {
    return fallback;
  }
  const withToken = raw.includes("{agentId}") ? raw.replaceAll("{agentId}", agentId) : raw;
  return resolveUserPath(withToken);
}

function mergeConfig(
  defaults: MemorySearchConfig | undefined,
  overrides: MemorySearchConfig | undefined,
  agentId: string,
): ResolvedMemorySearchConfig {
  const enabled = overrides?.enabled ?? defaults?.enabled ?? true;
  const sessionMemory =
    overrides?.experimental?.sessionMemory ?? defaults?.experimental?.sessionMemory ?? false;
  const provider = overrides?.provider ?? defaults?.provider ?? "auto";
  const primaryAdapter = provider === "auto" ? undefined : getMemoryEmbeddingProvider(provider);
  const defaultRemote = defaults?.remote;
  const overrideRemote = overrides?.remote;
  const fallback = overrides?.fallback ?? defaults?.fallback ?? "none";
  const fallbackAdapter =
    fallback && fallback !== "none" ? getMemoryEmbeddingProvider(fallback) : undefined;
  const hasRemoteConfig = Boolean(
    overrideRemote?.baseUrl ||
    overrideRemote?.apiKey ||
    overrideRemote?.headers ||
    overrideRemote?.nonBatchConcurrency != null ||
    defaultRemote?.baseUrl ||
    defaultRemote?.apiKey ||
    defaultRemote?.headers ||
    defaultRemote?.nonBatchConcurrency != null,
  );
  const includeRemote =
    hasRemoteConfig ||
    provider === "auto" ||
    primaryAdapter?.transport !== "local" ||
    fallbackAdapter?.transport === "remote";
  const batch = {
    enabled: overrideRemote?.batch?.enabled ?? defaultRemote?.batch?.enabled ?? false,
    wait: overrideRemote?.batch?.wait ?? defaultRemote?.batch?.wait ?? true,
    concurrency: Math.max(
      1,
      overrideRemote?.batch?.concurrency ?? defaultRemote?.batch?.concurrency ?? 2,
    ),
    pollIntervalMs:
      overrideRemote?.batch?.pollIntervalMs ?? defaultRemote?.batch?.pollIntervalMs ?? 2000,
    timeoutMinutes:
      overrideRemote?.batch?.timeoutMinutes ?? defaultRemote?.batch?.timeoutMinutes ?? 60,
  };
  const remote = includeRemote
    ? {
        baseUrl: overrideRemote?.baseUrl ?? defaultRemote?.baseUrl,
        apiKey: overrideRemote?.apiKey ?? defaultRemote?.apiKey,
        headers: overrideRemote?.headers ?? defaultRemote?.headers,
        nonBatchConcurrency:
          overrideRemote?.nonBatchConcurrency ?? defaultRemote?.nonBatchConcurrency,
        batch,
      }
    : undefined;
  const modelDefault = provider === "auto" ? undefined : primaryAdapter?.defaultModel;
  const model = overrides?.model ?? defaults?.model ?? modelDefault ?? "";
  const inputType = overrides?.inputType?.trim() || defaults?.inputType?.trim() || undefined;
  const queryInputType =
    overrides?.queryInputType?.trim() || defaults?.queryInputType?.trim() || undefined;
  const documentInputType =
    overrides?.documentInputType?.trim() || defaults?.documentInputType?.trim() || undefined;
  const outputDimensionality = overrides?.outputDimensionality ?? defaults?.outputDimensionality;
  const local = {
    modelPath: overrides?.local?.modelPath ?? defaults?.local?.modelPath,
    modelCacheDir: overrides?.local?.modelCacheDir ?? defaults?.local?.modelCacheDir,
    contextSize: overrides?.local?.contextSize ?? defaults?.local?.contextSize,
  };
  const sources = normalizeSources(overrides?.sources ?? defaults?.sources, sessionMemory);
  const rawPaths = [...(defaults?.extraPaths ?? []), ...(overrides?.extraPaths ?? [])]
    .map((value) => value.trim())
    .filter(Boolean);
  const extraPaths = Array.from(new Set(rawPaths));
  const multimodal = normalizeMemoryMultimodalSettings({
    enabled: overrides?.multimodal?.enabled ?? defaults?.multimodal?.enabled,
    modalities: overrides?.multimodal?.modalities ?? defaults?.multimodal?.modalities,
    maxFileBytes: overrides?.multimodal?.maxFileBytes ?? defaults?.multimodal?.maxFileBytes,
  });
  const vector = {
    enabled: overrides?.store?.vector?.enabled ?? defaults?.store?.vector?.enabled ?? true,
    extensionPath:
      overrides?.store?.vector?.extensionPath ?? defaults?.store?.vector?.extensionPath,
  };
  const fts = {
    tokenizer: overrides?.store?.fts?.tokenizer ?? defaults?.store?.fts?.tokenizer ?? "unicode61",
  };
  const store = {
    driver: overrides?.store?.driver ?? defaults?.store?.driver ?? "sqlite",
    path: resolveStorePath(agentId, overrides?.store?.path ?? defaults?.store?.path),
    fts,
    vector,
  };
  const chunkingStrategy =
    overrides?.chunking?.strategy ?? defaults?.chunking?.strategy ?? "fixed-size";
  const chunking = resolveChunkingConfig(chunkingStrategy, overrides?.chunking, defaults?.chunking);
  const sync = resolveSyncConfig(defaults, overrides);
  const query = {
    maxResults: overrides?.query?.maxResults ?? defaults?.query?.maxResults ?? DEFAULT_MAX_RESULTS,
    minScore: overrides?.query?.minScore ?? defaults?.query?.minScore ?? DEFAULT_MIN_SCORE,
  };
  const hybrid = {
    enabled:
      overrides?.query?.hybrid?.enabled ??
      defaults?.query?.hybrid?.enabled ??
      DEFAULT_HYBRID_ENABLED,
    vectorWeight:
      overrides?.query?.hybrid?.vectorWeight ??
      defaults?.query?.hybrid?.vectorWeight ??
      DEFAULT_HYBRID_VECTOR_WEIGHT,
    textWeight:
      overrides?.query?.hybrid?.textWeight ??
      defaults?.query?.hybrid?.textWeight ??
      DEFAULT_HYBRID_TEXT_WEIGHT,
    candidateMultiplier:
      overrides?.query?.hybrid?.candidateMultiplier ??
      defaults?.query?.hybrid?.candidateMultiplier ??
      DEFAULT_HYBRID_CANDIDATE_MULTIPLIER,
    mmr: {
      enabled:
        overrides?.query?.hybrid?.mmr?.enabled ??
        defaults?.query?.hybrid?.mmr?.enabled ??
        DEFAULT_MMR_ENABLED,
      lambda:
        overrides?.query?.hybrid?.mmr?.lambda ??
        defaults?.query?.hybrid?.mmr?.lambda ??
        DEFAULT_MMR_LAMBDA,
    },
    temporalDecay: {
      enabled:
        overrides?.query?.hybrid?.temporalDecay?.enabled ??
        defaults?.query?.hybrid?.temporalDecay?.enabled ??
        DEFAULT_TEMPORAL_DECAY_ENABLED,
      halfLifeDays:
        overrides?.query?.hybrid?.temporalDecay?.halfLifeDays ??
        defaults?.query?.hybrid?.temporalDecay?.halfLifeDays ??
        DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS,
    },
  };
  const cache = {
    enabled: overrides?.cache?.enabled ?? defaults?.cache?.enabled ?? DEFAULT_CACHE_ENABLED,
    maxEntries: overrides?.cache?.maxEntries ?? defaults?.cache?.maxEntries,
  };

  const minScore = clampNumber(query.minScore, 0, 1);
  const vectorWeight = clampNumber(hybrid.vectorWeight, 0, 1);
  const textWeight = clampNumber(hybrid.textWeight, 0, 1);
  const sum = vectorWeight + textWeight;
  const normalizedVectorWeight = sum > 0 ? vectorWeight / sum : DEFAULT_HYBRID_VECTOR_WEIGHT;
  const normalizedTextWeight = sum > 0 ? textWeight / sum : DEFAULT_HYBRID_TEXT_WEIGHT;
  const candidateMultiplier = clampInt(hybrid.candidateMultiplier, 1, 20);
  const temporalDecayHalfLifeDays = Math.max(
    1,
    Math.floor(
      Number.isFinite(hybrid.temporalDecay.halfLifeDays)
        ? hybrid.temporalDecay.halfLifeDays
        : DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS,
    ),
  );
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
    experimental: {
      sessionMemory,
    },
    fallback,
    model,
    inputType,
    queryInputType,
    documentInputType,
    outputDimensionality,
    local,
    store,
    chunking,
    sync: {
      ...sync,
      sessions: {
        deltaBytes,
        deltaMessages,
        postCompactionForce,
      },
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
          lambda: Number.isFinite(hybrid.mmr.lambda)
            ? Math.max(0, Math.min(1, hybrid.mmr.lambda))
            : DEFAULT_MMR_LAMBDA,
        },
        temporalDecay: {
          enabled: hybrid.temporalDecay.enabled,
          halfLifeDays: temporalDecayHalfLifeDays,
        },
      },
    },
    cache: {
      enabled: cache.enabled,
      maxEntries:
        typeof cache.maxEntries === "number" && Number.isFinite(cache.maxEntries)
          ? Math.max(1, Math.floor(cache.maxEntries))
          : undefined,
    },
  };
}

function resolveSyncConfig(
  defaults: MemorySearchConfig | undefined,
  overrides: MemorySearchConfig | undefined,
): ResolvedMemorySearchSyncConfig {
  return {
    onSessionStart: overrides?.sync?.onSessionStart ?? defaults?.sync?.onSessionStart ?? true,
    onSearch: overrides?.sync?.onSearch ?? defaults?.sync?.onSearch ?? true,
    watch: overrides?.sync?.watch ?? defaults?.sync?.watch ?? true,
    watchDebounceMs:
      overrides?.sync?.watchDebounceMs ??
      defaults?.sync?.watchDebounceMs ??
      DEFAULT_WATCH_DEBOUNCE_MS,
    intervalMinutes: overrides?.sync?.intervalMinutes ?? defaults?.sync?.intervalMinutes ?? 0,
    embeddingBatchTimeoutSeconds:
      overrides?.sync?.embeddingBatchTimeoutSeconds ?? defaults?.sync?.embeddingBatchTimeoutSeconds,
    sessions: {
      deltaBytes:
        overrides?.sync?.sessions?.deltaBytes ??
        defaults?.sync?.sessions?.deltaBytes ??
        DEFAULT_SESSION_DELTA_BYTES,
      deltaMessages:
        overrides?.sync?.sessions?.deltaMessages ??
        defaults?.sync?.sessions?.deltaMessages ??
        DEFAULT_SESSION_DELTA_MESSAGES,
      postCompactionForce:
        overrides?.sync?.sessions?.postCompactionForce ??
        defaults?.sync?.sessions?.postCompactionForce ??
        true,
    },
  };
}

export function resolveMemorySearchConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedMemorySearchConfig | null {
  const defaults = cfg.agents?.defaults?.memorySearch;
  const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
  const resolved = mergeConfig(defaults, overrides, agentId);
  if (!resolved.enabled) {
    return null;
  }
  const multimodalActive = isMemoryMultimodalEnabled(resolved.multimodal);
  const multimodalProvider =
    resolved.provider === "auto" ? undefined : getMemoryEmbeddingProvider(resolved.provider);
  // Config resolution is a startup/doctor hot path; only validate adapters
  // already registered by the active runtime instead of cold-loading plugins.
  if (
    multimodalActive &&
    multimodalProvider &&
    !(multimodalProvider.supportsMultimodalEmbeddings?.({ model: resolved.model }) ?? false)
  ) {
    throw new Error(
      "agents.*.memorySearch.multimodal requires a provider adapter that supports multimodal embeddings for the configured model.",
    );
  }
  if (multimodalActive && resolved.fallback !== "none") {
    throw new Error(
      'agents.*.memorySearch.multimodal does not support memorySearch.fallback. Set fallback to "none".',
    );
  }
  return resolved;
}

export function resolveMemorySearchSyncConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedMemorySearchSyncConfig | null {
  const defaults = cfg.agents?.defaults?.memorySearch;
  const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
  const enabled = overrides?.enabled ?? defaults?.enabled ?? true;
  if (!enabled) {
    return null;
  }
  return resolveSyncConfig(defaults, overrides);
}
