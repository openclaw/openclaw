import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MemoryConfig = {
  embedding: {
    provider: "openai" | "google";
    model?: string;
    apiKey: string;
  };
  dbPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
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
  "gemini-embedding-001": 768,
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

function resolveEmbeddingProvider(model: string, explicitProvider?: string): "openai" | "google" {
  // If provider is explicitly specified, use it
  if (explicitProvider === "google" || explicitProvider === "openai") {
    return explicitProvider;
  }
  // Otherwise, auto-detect based on model name
  if (model.startsWith("gemini-")) {
    return "google";
  }
  return "openai";
}

// Typebox schema for config validation
export const memoryConfigTypeboxSchema = Type.Object({
  embedding: Type.Object({
    apiKey: Type.String({
      description: "API key for embeddings provider",
    }),
    provider: Type.Optional(
      Type.Union([Type.Literal("openai"), Type.Literal("google")], {
        description: "Embedding provider (auto-detected from model if not specified)",
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          "Embedding model to use (OpenAI: text-embedding-3-small/3-large, Google: gemini-embedding-001)",
      }),
    ),
  }),
  dbPath: Type.Optional(
    Type.String({
      description: "Database path",
    }),
  ),
  autoCapture: Type.Optional(
    Type.Boolean({
      description: "Automatically capture important information from conversations",
    }),
  ),
  autoRecall: Type.Optional(
    Type.Boolean({
      description: "Automatically inject relevant memories into context",
    }),
  ),
});

export const memoryConfigSchema = {
  parse(value: unknown): MemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(cfg, ["embedding", "dbPath", "autoCapture", "autoRecall"], "memory config");

    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding.apiKey !== "string") {
      throw new Error("embedding.apiKey is required");
    }
    assertAllowedKeys(embedding, ["apiKey", "model", "provider"], "embedding config");

    const model = resolveEmbeddingModel(embedding);
    const explicitProvider =
      typeof embedding.provider === "string" ? embedding.provider : undefined;
    const provider = resolveEmbeddingProvider(model, explicitProvider);

    return {
      embedding: {
        provider,
        model,
        apiKey: resolveEnvVars(embedding.apiKey),
      },
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
    };
  },
  uiHints: {
    "embedding.apiKey": {
      label: "API Key",
      sensitive: true,
      placeholder: "sk-proj-... (for OpenAI) or AIza... (for Google)",
      help: "API key for embeddings provider (use ${OPENAI_API_KEY} or ${GOOGLE_API_KEY})",
    },
    "embedding.provider": {
      label: "Provider",
      help: "Embedding provider (auto-detected from model if not specified)",
    },
    "embedding.model": {
      label: "Embedding Model",
      placeholder: DEFAULT_MODEL,
      help: "Embedding model to use (OpenAI or Google Gemini)",
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
  },
};
