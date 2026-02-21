import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MemoryConfig = {
  embedding: {
    provider: "openai";
    model?: string;
    apiKey: string;
    baseUrl?: string;
    dimensions?: number;
  };
  dbPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  captureMaxChars?: number;
};

export const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

const DEFAULT_MODEL = "text-embedding-3-small";
export const DEFAULT_CAPTURE_MAX_CHARS = 500;
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
const MAX_EMBEDDING_DIMENSIONS = 32_768;

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

export function vectorDimsForModel(model: string, dimensions?: number): number {
  if (typeof dimensions === "number") {
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_EMBEDDING_DIMENSIONS) {
      throw new Error(
        `embedding.dimensions must be an integer between 1 and ${MAX_EMBEDDING_DIMENSIONS}`,
      );
    }
    return dimensions;
  }
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(
      `Unsupported embedding model: ${model}. Set embedding.dimensions for custom models.`,
    );
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
  const model = typeof embedding.model === "string" ? embedding.model.trim() : DEFAULT_MODEL;
  if (!model) {
    return DEFAULT_MODEL;
  }
  return model;
}

function resolveEmbeddingBaseUrl(embedding: Record<string, unknown>): string | undefined {
  if (typeof embedding.baseUrl !== "string") {
    return undefined;
  }
  const resolved = resolveEnvVars(embedding.baseUrl).trim();
  if (!resolved) {
    throw new Error("embedding.baseUrl cannot be empty");
  }
  return resolved;
}

function resolveEmbeddingDimensions(embedding: Record<string, unknown>): number | undefined {
  if (typeof embedding.dimensions === "undefined") {
    return undefined;
  }
  if (typeof embedding.dimensions !== "number" || !Number.isInteger(embedding.dimensions)) {
    throw new Error("embedding.dimensions must be an integer");
  }
  return embedding.dimensions;
}

function resolveEmbeddingApiKey(embedding: Record<string, unknown>): string {
  if (typeof embedding.apiKey !== "string") {
    throw new Error("embedding.apiKey is required");
  }
  const resolved = resolveEnvVars(embedding.apiKey).trim();
  if (!resolved) {
    throw new Error("embedding.apiKey is required");
  }
  return resolved;
}

export const memoryConfigSchema = {
  parse(value: unknown): MemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["embedding", "dbPath", "autoCapture", "autoRecall", "captureMaxChars"],
      "memory config",
    );

    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding) {
      throw new Error("embedding.apiKey is required");
    }
    assertAllowedKeys(embedding, ["apiKey", "model", "baseUrl", "dimensions"], "embedding config");

    const model = resolveEmbeddingModel(embedding);
    const apiKey = resolveEmbeddingApiKey(embedding);
    const baseUrl = resolveEmbeddingBaseUrl(embedding);
    const dimensions = resolveEmbeddingDimensions(embedding);
    // Validate the final vector size source (model default or explicit override).
    vectorDimsForModel(model, dimensions);

    const captureMaxChars =
      typeof cfg.captureMaxChars === "number" ? Math.floor(cfg.captureMaxChars) : undefined;
    if (
      typeof captureMaxChars === "number" &&
      (captureMaxChars < 100 || captureMaxChars > 10_000)
    ) {
      throw new Error("captureMaxChars must be between 100 and 10000");
    }

    return {
      embedding: {
        provider: "openai",
        model,
        apiKey,
        baseUrl,
        dimensions,
      },
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
      autoCapture: cfg.autoCapture === true,
      autoRecall: cfg.autoRecall !== false,
      captureMaxChars: captureMaxChars ?? DEFAULT_CAPTURE_MAX_CHARS,
    };
  },
  uiHints: {
    "embedding.apiKey": {
      label: "Embedding API Key",
      sensitive: true,
      placeholder: "sk-proj-... (or lm-studio)",
      help: "API key for your OpenAI-compatible embeddings endpoint",
    },
    "embedding.model": {
      label: "Embedding Model",
      placeholder: DEFAULT_MODEL,
      help: "Embedding model id (any OpenAI-compatible endpoint)",
    },
    "embedding.baseUrl": {
      label: "Embedding Base URL",
      placeholder: "http://127.0.0.1:1234/v1",
      help: "Optional OpenAI-compatible embeddings endpoint",
      advanced: true,
    },
    "embedding.dimensions": {
      label: "Embedding Dimensions",
      placeholder: "768",
      help: "Optional vector size override for custom embedding models",
      advanced: true,
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
    captureMaxChars: {
      label: "Capture Max Chars",
      help: "Maximum message length eligible for auto-capture",
      advanced: true,
      placeholder: String(DEFAULT_CAPTURE_MAX_CHARS),
    },
  },
};
