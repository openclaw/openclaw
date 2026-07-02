// Memory Lancedb helper module supports config behavior.
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { QUERY_EMBED_CACHE_MAX_ENTRIES as DEFAULT_QUERY_EMBED_CACHE_MAX_ENTRIES } from "./query-embedding-cache.js";

export type MemoryConfig = {
  embedding: {
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    dimensions?: number;
  };
  dreaming?: Record<string, unknown>;
  dbPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  captureMaxChars?: number;
  customTriggers?: string[];
  recallMaxChars?: number;
  storageOptions?: Record<string, string>;
  // Resolved query-embedding recall cache settings (always present after parse).
  // This is the in-memory LRU that collapses repeated recall-query embeds within
  // a turn; it is distinct from the host's `memorySearch.cache` (chunk embeddings
  // in SQLite). maxEntries is left undefined when unset so the cache applies its
  // own default capacity (QUERY_EMBED_CACHE_MAX_ENTRIES).
  queryEmbeddingCache: {
    enabled: boolean;
    maxEntries?: number;
  };
};

export const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

const DEFAULT_MODEL = "text-embedding-3-small";
export const DEFAULT_CAPTURE_MAX_CHARS = 500;
export const DEFAULT_RECALL_MAX_CHARS = 1000;
const LEGACY_STATE_DIRS: string[] = [];

function resolveDefaultDbPath(): string {
  const home = homedir();
  const preferred = join(home, ".openclaw", "memory", "lancedb");
  try {
    if (fs.existsSync(preferred)) {
      return preferred;
    }
  } catch {
    // best-effort
  }

  for (const legacy of LEGACY_STATE_DIRS) {
    const candidate = join(home, legacy, "memory", "lancedb");
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // best-effort
    }
  }

  return preferred;
}

const DEFAULT_DB_PATH = resolveDefaultDbPath();

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};
const EMBEDDING_CONFIG_KEYS = ["provider", "apiKey", "model", "baseUrl", "dimensions"] as const;

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

export function vectorDimsForModel(model: string): number {
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(`Unsupported embedding model: ${model}`);
  }
  return dims;
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function resolveEmbeddingModel(
  embedding: Record<string, unknown>,
  dimensions: number | undefined,
): string {
  const model = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;
  if (dimensions === undefined) {
    vectorDimsForModel(model);
  }
  return model;
}

function resolveFiniteIntegerConfig(value: unknown): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  const parsed = parseFiniteNumber(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

function resolveBoundedIntegerConfig(params: {
  value: unknown;
  fallback: number;
  min: number;
  max: number;
  label: string;
}): number {
  const resolved = resolveFiniteIntegerConfig(params.value) ?? params.fallback;
  if (resolved < params.min || resolved > params.max) {
    throw new Error(`${params.label} must be between ${params.min} and ${params.max}`);
  }
  return resolved;
}

// Upper bound for the configurable query-embedding cache capacity. Generous on
// purpose: the cache is a small per-instance LRU of recall-query vectors, so the
// only real constraint is memory, and the sane default (when unset) is the
// QUERY_EMBED_CACHE_MAX_ENTRIES constant applied by the cache itself.
const MAX_QUERY_EMBED_CACHE_ENTRIES = 1_000_000;

function resolveQueryEmbeddingCacheConfig(query: unknown): MemoryConfig["queryEmbeddingCache"] {
  // Default-off: existing users who omit `query` see no behavior change (cache
  // stays disabled). Opt in with `query.embeddingCache.enabled: true`.
  if (query === undefined) {
    return { enabled: false };
  }
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new Error("query config must be an object");
  }
  const queryCfg = query as Record<string, unknown>;
  assertAllowedKeys(queryCfg, ["embeddingCache"], "query config");

  const rawCache = queryCfg.embeddingCache;
  if (rawCache === undefined) {
    return { enabled: false };
  }
  if (!rawCache || typeof rawCache !== "object" || Array.isArray(rawCache)) {
    throw new Error("query.embeddingCache must be an object");
  }
  const cache = rawCache as Record<string, unknown>;
  assertAllowedKeys(cache, ["enabled", "maxEntries"], "query.embeddingCache");

  if (cache.enabled !== undefined && typeof cache.enabled !== "boolean") {
    throw new Error("query.embeddingCache.enabled must be a boolean");
  }
  // Opt-in: require explicit true; any other value (false, undefined) leaves cache off.
  const enabled = cache.enabled === true;

  let maxEntries: number | undefined;
  if (cache.maxEntries !== undefined) {
    const parsedMaxEntries =
      typeof cache.maxEntries === "number" ? parseFiniteNumber(cache.maxEntries) : undefined;
    if (
      parsedMaxEntries === undefined ||
      !Number.isInteger(parsedMaxEntries) ||
      parsedMaxEntries < 1 ||
      parsedMaxEntries > MAX_QUERY_EMBED_CACHE_ENTRIES
    ) {
      throw new Error(
        `query.embeddingCache.maxEntries must be between 1 and ${MAX_QUERY_EMBED_CACHE_ENTRIES}`,
      );
    }
    maxEntries = parsedMaxEntries;
  }

  return maxEntries === undefined ? { enabled } : { enabled, maxEntries };
}

function resolveEmbeddingDimensions(embedding: Record<string, unknown>): number | undefined {
  if (embedding.dimensions === undefined) {
    return undefined;
  }
  const dimensions =
    typeof embedding.dimensions === "number" ? parseFiniteNumber(embedding.dimensions) : undefined;
  if (dimensions === undefined || !Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error("embedding.dimensions must be a positive integer");
  }
  return dimensions;
}

export const memoryConfigSchema = {
  parse(value: unknown): MemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      [
        "embedding",
        "dreaming",
        "dbPath",
        "autoCapture",
        "autoRecall",
        "captureMaxChars",
        "customTriggers",
        "recallMaxChars",
        "storageOptions",
        "query",
      ],
      "memory config",
    );

    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding !== "object" || Array.isArray(embedding)) {
      throw new Error("embedding config required");
    }
    assertAllowedKeys(embedding, [...EMBEDDING_CONFIG_KEYS], "embedding config");
    if (Object.keys(embedding).length === 0) {
      throw new Error("embedding config must include at least one setting");
    }

    const dimensions = resolveEmbeddingDimensions(embedding);
    const model = resolveEmbeddingModel(embedding, dimensions);
    const provider = typeof embedding.provider === "string" ? embedding.provider.trim() : "openai";
    if (!provider) {
      throw new Error("embedding.provider must not be empty");
    }

    const captureMaxChars = resolveBoundedIntegerConfig({
      value: cfg.captureMaxChars,
      fallback: DEFAULT_CAPTURE_MAX_CHARS,
      min: 100,
      max: 10_000,
      label: "captureMaxChars",
    });
    const recallMaxChars = resolveBoundedIntegerConfig({
      value: cfg.recallMaxChars,
      fallback: DEFAULT_RECALL_MAX_CHARS,
      min: 100,
      max: 10_000,
      label: "recallMaxChars",
    });
    let customTriggers: string[] | undefined;
    if (cfg.customTriggers !== undefined) {
      if (!Array.isArray(cfg.customTriggers)) {
        throw new Error("customTriggers must be an array of strings");
      }
      customTriggers = cfg.customTriggers.map((trigger, index) => {
        if (typeof trigger !== "string") {
          throw new Error(`customTriggers.${index} must be a string`);
        }
        const normalized = trigger.trim();
        if (!normalized) {
          throw new Error(`customTriggers.${index} must not be empty`);
        }
        if (normalized.length > 100) {
          throw new Error(`customTriggers.${index} must be at most 100 characters`);
        }
        return normalized;
      });
      if (customTriggers.length > 50) {
        throw new Error("customTriggers must include at most 50 entries");
      }
    }

    const queryEmbeddingCache = resolveQueryEmbeddingCacheConfig(cfg.query);

    const dreaming =
      cfg.dreaming === undefined
        ? undefined
        : cfg.dreaming && typeof cfg.dreaming === "object" && !Array.isArray(cfg.dreaming)
          ? (cfg.dreaming as Record<string, unknown>)
          : (() => {
              throw new Error("dreaming config must be an object");
            })();

    // Parse storageOptions (object with string values)
    let storageOptions: Record<string, string> | undefined;
    const storageOpts = cfg.storageOptions as Record<string, unknown> | undefined;
    if (storageOpts !== undefined && storageOpts !== null) {
      if (!storageOpts || typeof storageOpts !== "object" || Array.isArray(storageOpts)) {
        throw new Error("storageOptions must be an object");
      }
      storageOptions = {};
      // Validate all values are strings
      for (const [key, valueLocal] of Object.entries(storageOpts)) {
        if (typeof valueLocal !== "string") {
          throw new Error(`storageOptions.${key} must be a string`);
        }
        storageOptions[key] = resolveEnvVars(valueLocal);
      }
    }

    return {
      embedding: {
        provider,
        model,
        apiKey: typeof embedding.apiKey === "string" ? resolveEnvVars(embedding.apiKey) : undefined,
        baseUrl:
          typeof embedding.baseUrl === "string" ? resolveEnvVars(embedding.baseUrl) : undefined,
        dimensions,
      },
      dreaming,
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
      autoCapture: cfg.autoCapture === true,
      autoRecall: cfg.autoRecall !== false,
      captureMaxChars,
      ...(customTriggers ? { customTriggers } : {}),
      recallMaxChars,
      ...(storageOptions ? { storageOptions } : {}),
      queryEmbeddingCache,
    };
  },
  uiHints: {
    "embedding.provider": {
      label: "Embedding Provider",
      placeholder: "openai",
      help: "Memory embedding provider adapter to use (for example openai, github-copilot, ollama)",
    },
    "embedding.apiKey": {
      label: "OpenAI API Key",
      sensitive: true,
      placeholder: "sk-proj-...",
      help: "Optional API key override for OpenAI-compatible embeddings; omit to use configured provider auth",
    },
    "embedding.baseUrl": {
      label: "Base URL",
      placeholder: "https://api.openai.com/v1",
      help: "Optional provider or OpenAI-compatible embedding endpoint base URL",
      advanced: true,
    },
    "embedding.dimensions": {
      label: "Dimensions",
      placeholder: "1536",
      help: "Vector dimensions for custom models (required for non-standard models)",
      advanced: true,
    },
    "embedding.model": {
      label: "Embedding Model",
      placeholder: DEFAULT_MODEL,
      help: "OpenAI embedding model to use",
    },
    dbPath: {
      label: "Database Path",
      placeholder: "~/.openclaw/memory/lancedb",
      advanced: true,
      help: "Local filesystem path or cloud storage URI (s3://, gs://) for LanceDB database",
    },
    autoCapture: {
      label: "Auto-Capture",
      help: "Automatically capture important information from conversations",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject relevant memories into context",
    },
    captureMaxChars: {
      label: "Capture Max Chars",
      help: "Maximum message length eligible for auto-capture",
      advanced: true,
      placeholder: String(DEFAULT_CAPTURE_MAX_CHARS),
    },
    customTriggers: {
      label: "Custom Triggers",
      help: "Literal phrases that should make auto-capture consider a message memory-worthy",
      advanced: true,
    },
    recallMaxChars: {
      label: "Recall Query Max Chars",
      help: "Maximum prompt/query length embedded for memory recall. Lower for small local embedding models.",
      advanced: true,
      placeholder: String(DEFAULT_RECALL_MAX_CHARS),
    },
    storageOptions: {
      label: "Storage Options",
      sensitive: true,
      advanced: true,
      help: "Storage configuration options (access_key, secret_key, endpoint, etc.); supports ${ENV_VAR} values",
    },
    "query.embeddingCache.enabled": {
      label: "Query Embedding Recall Cache",
      advanced: true,
      help: "Reuse the embedding vector for an identical recall query within a turn (memory_recall, auto-recall, and capture can otherwise embed the same query several times). In-memory only; distinct from the host Memory Search Embedding Cache, which caches chunk embeddings in SQLite.",
    },
    "query.embeddingCache.maxEntries": {
      label: "Query Embedding Cache Max Entries",
      advanced: true,
      placeholder: String(DEFAULT_QUERY_EMBED_CACHE_MAX_ENTRIES),
      help: "Maximum number of recall-query embeddings kept in the in-memory LRU before the least-recently-used entry is evicted.",
    },
  },
};
