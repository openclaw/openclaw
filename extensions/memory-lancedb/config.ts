import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MemoryConfig = {
  embedding: {
    provider: "openai" | "google";
    model: string;
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
  "text-embedding-004": 768,
  "models/text-embedding-004": 768,
  "gemini-embedding-001": 768,
  "models/gemini-embedding-001": 768,
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
  if (typeof embedding.dimensions !== "number") {
    vectorDimsForModel(model);
  }
  return model;
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
    if (!embedding || typeof embedding.apiKey !== "string") {
      throw new Error("embedding.apiKey is required");
    }
    assertAllowedKeys(embedding, ["apiKey", "model", "baseUrl", "dimensions", "provider"], "embedding config");

    const model = resolveEmbeddingModel(embedding);
    
    // Auto-detect Google provider if model is a known Google model and provider isn't explicitly set
    let provider = typeof embedding.provider === "string" ? embedding.provider : "openai";
    if (model.includes("text-embedding-004") || model.includes("gemini-embedding-001") || model.startsWith("models/")) {
      provider = "google";
    }

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
        provider: provider as "openai" | "google",
        model,
        apiKey: resolveEnvVars(embedding.apiKey),
        baseUrl:
          typeof embedding.baseUrl === "string" ? resolveEnvVars(embedding.baseUrl) : undefined,
        dimensions: typeof embedding.dimensions === "number" ? embedding.dimensions : undefined,
      },
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
      autoCapture: cfg.autoCapture === true,
      autoRecall: cfg.autoRecall !== false,
      captureMaxChars: captureMaxChars ?? DEFAULT_CAPTURE_MAX_CHARS,
    };
  },
  uiHints: {
    "embedding.apiKey": {
      label: "API Key",
      sensitive: true,
      placeholder: "sk-proj-...",
      help: "API key for OpenAI or Gemini embeddings (or use ${OPENAI_API_KEY} / ${GOOGLE_API_KEY})",
    },
    "embedding.baseUrl": {
      label: "Base URL",
      placeholder: "https://api.openai.com/v1",
      help: "Base URL for compatible providers (e.g. http://localhost:11434/v1)",
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
      help: "OpenAI or Google embedding model to use",
    },
    "embedding.provider": {
      label: "Provider",
      placeholder: "openai",
      help: "API Provider (openai or google). Auto-detected for known models.",
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
