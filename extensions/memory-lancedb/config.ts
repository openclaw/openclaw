import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type OpenAIEmbeddingConfig = {
  provider?: "openai";
  model?: string;
  apiKey: string;
  baseUrl?: string;
  dims?: number;
};

export type OllamaEmbeddingConfig = {
  provider: "ollama";
  model: string;
  baseUrl?: string;
  dims?: number;
};

export type MemoryConfig = {
  embedding: OpenAIEmbeddingConfig | OllamaEmbeddingConfig;
  dbPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  captureMaxChars?: number;
};

export const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
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

export function tryVectorDimsForModel(model?: string): number | undefined {
  if (!model) {
    return undefined;
  }
  return EMBEDDING_DIMENSIONS[model];
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

function parseDims(value: unknown): number | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("embedding.dims must be a positive integer");
  }
  const dims = Math.floor(value);
  if (dims <= 0) {
    throw new Error("embedding.dims must be a positive integer");
  }
  return dims;
}

function parseOpenAIEmbeddingConfig(raw: Record<string, unknown>): OpenAIEmbeddingConfig {
  assertAllowedKeys(raw, ["provider", "apiKey", "model", "baseUrl", "dims"], "embedding config");

  if (typeof raw.apiKey !== "string") {
    throw new Error("embedding.apiKey is required");
  }

  const model = typeof raw.model === "string" ? raw.model : DEFAULT_OPENAI_MODEL;
  const dims = parseDims(raw.dims) ?? tryVectorDimsForModel(model);

  return {
    provider: "openai",
    model,
    apiKey: resolveEnvVars(raw.apiKey),
    baseUrl: typeof raw.baseUrl === "string" ? resolveEnvVars(raw.baseUrl) : undefined,
    dims,
  };
}

function parseOllamaEmbeddingConfig(raw: Record<string, unknown>): OllamaEmbeddingConfig {
  assertAllowedKeys(raw, ["provider", "model", "baseUrl", "dims"], "embedding config");

  if (typeof raw.model !== "string" || raw.model.trim().length === 0) {
    throw new Error("embedding.model is required when embedding.provider is 'ollama'");
  }

  return {
    provider: "ollama",
    model: raw.model,
    baseUrl:
      typeof raw.baseUrl === "string" ? resolveEnvVars(raw.baseUrl) : DEFAULT_OLLAMA_BASE_URL,
    dims: parseDims(raw.dims),
  };
}

function parseEmbeddingConfig(
  embedding: Record<string, unknown> | undefined,
): MemoryConfig["embedding"] {
  if (!embedding || typeof embedding !== "object") {
    throw new Error("embedding config is required");
  }

  const provider =
    typeof embedding.provider === "string" && embedding.provider.length > 0
      ? embedding.provider
      : "openai";

  if (provider === "ollama") {
    return parseOllamaEmbeddingConfig(embedding);
  }

  if (provider === "openai") {
    return parseOpenAIEmbeddingConfig(embedding);
  }

  throw new Error(`Unsupported embedding.provider: ${provider}`);
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

    const parsedEmbedding = parseEmbeddingConfig(
      cfg.embedding as Record<string, unknown> | undefined,
    );

    const captureMaxChars =
      typeof cfg.captureMaxChars === "number" ? Math.floor(cfg.captureMaxChars) : undefined;
    if (
      typeof captureMaxChars === "number" &&
      (captureMaxChars < 100 || captureMaxChars > 10_000)
    ) {
      throw new Error("captureMaxChars must be between 100 and 10000");
    }

    return {
      embedding: parsedEmbedding,
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
      autoCapture: cfg.autoCapture === true,
      autoRecall: cfg.autoRecall !== false,
      captureMaxChars: captureMaxChars ?? DEFAULT_CAPTURE_MAX_CHARS,
    };
  },
  uiHints: {
    "embedding.provider": {
      label: "Embedding Provider",
      help: "Use 'openai' for OpenAI-compatible APIs, or 'ollama' for local models",
      placeholder: "openai",
    },
    "embedding.apiKey": {
      label: "OpenAI API Key",
      sensitive: true,
      placeholder: "sk-proj-...",
      help: "API key for OpenAI-compatible embeddings (or use ${OPENAI_API_KEY})",
    },
    "embedding.model": {
      label: "Embedding Model",
      placeholder: DEFAULT_OPENAI_MODEL,
      help: "Embedding model name for the selected provider",
    },
    "embedding.baseUrl": {
      label: "Embedding Base URL",
      placeholder: "https://api.openai.com/v1 or http://127.0.0.1:11434",
      help: "Optional OpenAI-compatible endpoint or Ollama server URL",
      advanced: true,
    },
    "embedding.dims": {
      label: "Embedding Dimensions",
      placeholder: "1536",
      help: "Optional vector dimensions override (auto-detected when omitted for unknown models)",
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
