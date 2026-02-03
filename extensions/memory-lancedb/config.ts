import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RerankerType = "rrf" | "linear";

export type HybridConfig = {
  enabled?: boolean; // default: true
  reranker?: RerankerType; // default: "rrf" (RRF is only available reranker in JS SDK)
  vectorWeight?: number; // 0-1, default: 0.7 (only used with "linear" reranker)
  textWeight?: number; // 0-1, default: 0.3 (only used with "linear" reranker)
};

export type MemoryConfig = {
  embedding: {
    provider: "openai";
    model?: string;
    apiKey: string;
  };
  dbPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  hybrid?: HybridConfig;
};

export const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

const DEFAULT_MODEL = "text-embedding-3-small";
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

function resolveEmbeddingModel(embedding: Record<string, unknown>): string {
  const model = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;
  vectorDimsForModel(model);
  return model;
}

/**
 * Clamps a number to the range [0, 1] and handles edge cases (NaN, Infinity).
 * Returns the default value if input is invalid.
 */
function clampWeight(value: unknown, defaultValue: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.max(0, Math.min(1, value));
}

function parseHybridConfig(hybrid: unknown): HybridConfig {
  if (!hybrid || typeof hybrid !== "object" || Array.isArray(hybrid)) {
    return { enabled: true, reranker: "rrf", vectorWeight: 0.7, textWeight: 0.3 };
  }
  const h = hybrid as Record<string, unknown>;
  assertAllowedKeys(h, ["enabled", "reranker", "vectorWeight", "textWeight"], "hybrid config");

  const reranker = h.reranker === "linear" ? "linear" : "rrf";

  return {
    enabled: h.enabled !== false,
    reranker,
    vectorWeight: clampWeight(h.vectorWeight, 0.7),
    textWeight: clampWeight(h.textWeight, 0.3),
  };
}

export const memoryConfigSchema = {
  parse(value: unknown): MemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["embedding", "dbPath", "autoCapture", "autoRecall", "hybrid"],
      "memory config",
    );

    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding.apiKey !== "string") {
      throw new Error("embedding.apiKey is required");
    }
    assertAllowedKeys(embedding, ["apiKey", "model"], "embedding config");

    const model = resolveEmbeddingModel(embedding);

    return {
      embedding: {
        provider: "openai",
        model,
        apiKey: resolveEnvVars(embedding.apiKey),
      },
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
      hybrid: parseHybridConfig(cfg.hybrid),
    };
  },
  uiHints: {
    "embedding.apiKey": {
      label: "OpenAI API Key",
      sensitive: true,
      placeholder: "sk-proj-...",
      help: "API key for OpenAI embeddings (or use ${OPENAI_API_KEY})",
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
    },
    autoCapture: {
      label: "Auto-Capture",
      help: "Automatically capture important information from conversations",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject relevant memories into context",
    },
    "hybrid.enabled": {
      label: "Hybrid Search",
      help: "Combine vector search with BM25 keyword search for better recall",
    },
    "hybrid.reranker": {
      label: "Reranker",
      placeholder: "rrf",
      help: "Reranking algorithm: 'rrf' (Reciprocal Rank Fusion) or 'linear' (weighted combination)",
      advanced: true,
    },
    "hybrid.vectorWeight": {
      label: "Vector Weight",
      placeholder: "0.7",
      help: "Weight for semantic vector search (0-1, only used with 'linear' reranker)",
      advanced: true,
    },
    "hybrid.textWeight": {
      label: "Text Weight",
      placeholder: "0.3",
      help: "Weight for BM25 keyword search (0-1, only used with 'linear' reranker)",
      advanced: true,
    },
  },
};
