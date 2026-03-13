import type { OpenClawConfig } from "../../../src/config/config.js";
import type {
  EmbeddingProviderFallback,
  EmbeddingProviderRequest,
} from "../../../src/memory/embeddings.js";
import { resolveUserPath } from "../../../src/utils.js";

export type LanceDbContextPluginConfig = {
  dbPath?: string;
  embedding?: {
    provider?: EmbeddingProviderRequest;
    fallback?: EmbeddingProviderFallback;
    model?: string;
    dimensions?: number;
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    localModelPath?: string;
    localModelCacheDir?: string;
  };
  assembly?: {
    recentTailTokens?: number;
    retrievalTopK?: number;
    retrievalMinScore?: number;
    maxRetrievedChars?: number;
    crossSessionScope?: "session_key";
    crossSessionRecallMode?: "summary-first";
  };
  maintenance?: {
    optimizeIntervalMinutes?: number;
  };
  limits?: {
    maxMessageCharsForEmbedding?: number;
    skipLargeToolResultChars?: number;
  };
};

export type ResolvedLanceDbContextConfig = {
  openclawConfig: OpenClawConfig;
  dbPath: string;
  embedding: {
    provider: EmbeddingProviderRequest;
    fallback: EmbeddingProviderFallback;
    model: string;
    dimensions: number;
    remote?: {
      baseUrl?: string;
      apiKey?: string;
      headers?: Record<string, string>;
    };
    local?: {
      modelPath?: string;
      modelCacheDir?: string;
    };
  };
  assembly: {
    recentTailTokens: number;
    retrievalTopK: number;
    retrievalMinScore: number;
    maxRetrievedChars: number;
    crossSessionScope: "session_key";
    crossSessionRecallMode: "summary-first";
  };
  maintenance: {
    optimizeIntervalMinutes: number;
  };
  limits: {
    maxMessageCharsForEmbedding: number;
    skipLargeToolResultChars: number;
  };
};

const DEFAULT_DB_PATH = "~/.openclaw/context/lancedb";
const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIMS_BY_MODEL: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => process.env[envVar] ?? "");
}

function resolvePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function resolveClampedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(max, Math.max(min, value));
  }
  return fallback;
}

function resolveDimensions(model: string, value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  const fallback = DEFAULT_DIMS_BY_MODEL[model];
  if (!fallback) {
    throw new Error(`lancedb-context: embedding.dimensions is required for model "${model}"`);
  }
  return fallback;
}

export function resolveLanceDbContextConfig(params: {
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  resolvePath: (input: string) => string;
}): ResolvedLanceDbContextConfig {
  const raw = (params.pluginConfig ?? {}) as LanceDbContextPluginConfig;
  const embedding = raw.embedding ?? {};
  const model = (embedding.model?.trim() || DEFAULT_MODEL).trim();
  const dimensions = resolveDimensions(model, embedding.dimensions);
  const dbPath = params.resolvePath(raw.dbPath?.trim() || DEFAULT_DB_PATH);

  return {
    openclawConfig: params.config,
    dbPath: resolveUserPath(dbPath),
    embedding: {
      provider: embedding.provider ?? "auto",
      fallback: embedding.fallback ?? "none",
      model,
      dimensions,
      remote:
        embedding.baseUrl || embedding.apiKey || embedding.headers
          ? {
              baseUrl: embedding.baseUrl ? resolveEnvVars(embedding.baseUrl) : undefined,
              apiKey: embedding.apiKey ? resolveEnvVars(embedding.apiKey) : undefined,
              headers: embedding.headers,
            }
          : undefined,
      local:
        embedding.localModelPath || embedding.localModelCacheDir
          ? {
              modelPath: embedding.localModelPath,
              modelCacheDir: embedding.localModelCacheDir,
            }
          : undefined,
    },
    assembly: {
      recentTailTokens: resolvePositiveInt(raw.assembly?.recentTailTokens, 12_000),
      retrievalTopK: resolvePositiveInt(raw.assembly?.retrievalTopK, 8),
      retrievalMinScore: resolveClampedNumber(raw.assembly?.retrievalMinScore, 0.2, -1, 1),
      maxRetrievedChars: resolvePositiveInt(raw.assembly?.maxRetrievedChars, 6_000),
      crossSessionScope: "session_key",
      crossSessionRecallMode: "summary-first",
    },
    maintenance: {
      optimizeIntervalMinutes: resolvePositiveInt(raw.maintenance?.optimizeIntervalMinutes, 30),
    },
    limits: {
      maxMessageCharsForEmbedding: resolvePositiveInt(
        raw.limits?.maxMessageCharsForEmbedding,
        4_000,
      ),
      skipLargeToolResultChars: resolvePositiveInt(raw.limits?.skipLargeToolResultChars, 8_000),
    },
  };
}
