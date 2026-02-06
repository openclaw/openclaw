import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MemoryConfig = {
  embedding: {
    provider: "openai" | "local";
    model?: string;
    apiKey?: string; // Optional now (not required for local)
  };
  dbPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
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

const LOCAL_DEFAULT_DIMENSIONS = 768;

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

export function vectorDimsForModel(model: string, localDimensions?: number): number {
  // Local model detection: .gguf files or Hugging Face references
  if (model.endsWith(".gguf") || model.startsWith("hf:")) {
    return localDimensions ?? LOCAL_DEFAULT_DIMENSIONS;
  }
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

export function detectProvider(config: { provider?: string; model?: string }): "openai" | "local" {
  if (config.provider) {
    return config.provider as "openai" | "local";
  }
  if (config.model?.endsWith(".gguf")) {
    return "local";
  }
  if (config.model?.startsWith("hf:")) {
    return "local";
  }
  if (config.model?.startsWith("text-embedding-")) {
    return "openai";
  }
  return "openai"; // default fallback
}

function resolveEmbeddingModel(
  embedding: Record<string, unknown>,
  provider: "openai" | "local",
): string {
  const model = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;
  // Validate dimensions are known (local models use default dims, so this won't throw for them)
  if (provider === "openai") {
    vectorDimsForModel(model);
  }
  return model;
}

const LOCAL_DEFAULT_MODEL = "hf:nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.f16.gguf";

/**
 * Resolve the model identifier actually used for embeddings.
 * For local provider, `local.modelPath` takes precedence over `embedding.model`.
 */
export function resolveEffectiveModel(cfg: MemoryConfig): string {
  if (cfg.embedding.provider === "local") {
    return cfg.local?.modelPath ?? cfg.embedding.model ?? LOCAL_DEFAULT_MODEL;
  }
  return cfg.embedding.model ?? DEFAULT_MODEL;
}

export const memoryConfigSchema = {
  parse(value: unknown): MemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["embedding", "dbPath", "autoCapture", "autoRecall", "local"],
      "memory config",
    );

    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding) {
      throw new Error("embedding config is required");
    }
    assertAllowedKeys(embedding, ["apiKey", "model", "provider"], "embedding config");

    const provider = detectProvider({
      provider: typeof embedding.provider === "string" ? embedding.provider : undefined,
      model: typeof embedding.model === "string" ? embedding.model : undefined,
    });

    // apiKey is required for OpenAI but optional for local
    if (provider === "openai" && typeof embedding.apiKey !== "string") {
      throw new Error("embedding.apiKey is required for OpenAI provider");
    }

    const model = resolveEmbeddingModel(embedding, provider);

    // Parse local config section
    const localCfg = cfg.local as Record<string, unknown> | undefined;
    let local: MemoryConfig["local"] | undefined;
    if (localCfg && typeof localCfg === "object") {
      assertAllowedKeys(localCfg, ["modelPath", "modelCacheDir"], "local config");
      local = {
        modelPath: typeof localCfg.modelPath === "string" ? localCfg.modelPath : undefined,
        modelCacheDir:
          typeof localCfg.modelCacheDir === "string" ? localCfg.modelCacheDir : undefined,
      };
    }

    return {
      embedding: {
        provider,
        model,
        apiKey: typeof embedding.apiKey === "string" ? resolveEnvVars(embedding.apiKey) : undefined,
      },
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
      local,
    };
  },
  uiHints: {
    "embedding.provider": {
      label: "Embedding Provider",
      placeholder: "openai",
      help: 'Embedding provider: "openai" for OpenAI API, "local" for node-llama-cpp',
    },
    "embedding.apiKey": {
      label: "OpenAI API Key",
      sensitive: true,
      placeholder: "sk-proj-...",
      help: "API key for OpenAI embeddings (or use ${OPENAI_API_KEY}). Not required for local provider.",
    },
    "embedding.model": {
      label: "Embedding Model",
      placeholder: DEFAULT_MODEL,
      help: "Embedding model to use. For local: a .gguf file path or hf: reference.",
    },
    "local.modelPath": {
      label: "Local Model Path",
      placeholder: "~/.openclaw/models/embedding.gguf",
      help: "Path to a local GGUF embedding model file",
      advanced: true,
    },
    "local.modelCacheDir": {
      label: "Model Cache Directory",
      placeholder: "~/.openclaw/models",
      help: "Directory for caching downloaded models",
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
