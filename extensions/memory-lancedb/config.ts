import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MemoryConfig = {
  embedding: {
    provider: "openai";
    model?: string;
    apiKey: string;
    baseUrl?: string;
    dimension?: number;
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

// Known embedding models and their dimensions
// Users can override with custom dimension for unlisted models
const EMBEDDING_DIMENSIONS: Record<string, number> = {
  // OpenAI
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  // SiliconFlow / Chinese models
  "BAAI/bge-m3": 1024,
  "BAAI/bge-large-zh-v1.5": 1024,
  "BAAI/bge-large-en-v1.5": 1024,
  "Qwen/Qwen3-Embedding-8B": 4096,
  // Jina
  "jina-embeddings-v3": 1024,
};

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

export function vectorDimsForModel(model: string, customDimension?: number): number {
  // Custom dimension takes precedence
  if (customDimension !== undefined && customDimension > 0) {
    return customDimension;
  }
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(
      `Unknown embedding model: ${model}. Please specify 'dimension' in config. ` +
        `Known models: ${Object.keys(EMBEDDING_DIMENSIONS).join(", ")}`,
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

function resolveOptionalEnvVars(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return resolveEnvVars(value);
}

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
    assertAllowedKeys(embedding, ["apiKey", "model", "baseUrl", "dimension"], "embedding config");

    const model = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;
    const dimension = typeof embedding.dimension === "number" ? embedding.dimension : undefined;

    // Validate dimension is available (either custom or known model)
    vectorDimsForModel(model, dimension);

    return {
      embedding: {
        provider: "openai",
        model,
        apiKey: resolveEnvVars(embedding.apiKey),
        baseUrl: resolveOptionalEnvVars(embedding.baseUrl as string | undefined),
        dimension,
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
      placeholder: "sk-...",
      help: "API key for embeddings (OpenAI, SiliconFlow, or compatible provider)",
    },
    "embedding.model": {
      label: "Embedding Model",
      placeholder: DEFAULT_MODEL,
      help: "Embedding model to use (e.g., text-embedding-3-small, BAAI/bge-m3, Qwen/Qwen3-Embedding-8B)",
    },
    "embedding.baseUrl": {
      label: "Base URL",
      placeholder: "https://api.openai.com/v1",
      help: "Custom API base URL for OpenAI-compatible providers (e.g., https://api.siliconflow.cn/v1)",
      advanced: true,
    },
    "embedding.dimension": {
      label: "Embedding Dimension",
      placeholder: "auto",
      help: "Vector dimension for custom models. Leave empty for known models.",
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
  },
};
