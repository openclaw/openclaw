import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AutoCaptureConfig = {
  enabled: boolean;
  /** LLM provider for memory extraction: "openrouter" (default) or "openai" */
  provider?: "openrouter" | "openai";
  /** LLM model for memory extraction (default: google/gemini-2.0-flash-001) */
  model?: string;
  /** API key for the LLM provider (supports ${ENV_VAR} syntax) */
  apiKey?: string;
  /** Base URL for the LLM provider (default: https://openrouter.ai/api/v1) */
  baseUrl?: string;
  /** Maximum messages to send for extraction (default: 10) */
  maxMessages?: number;
};

export type MemoryConfig = {
  embedding: {
    provider: "openai";
    model?: string;
    apiKey: string;
  };
  dbPath?: string;
  /** @deprecated Use autoCapture object instead. Boolean true enables with defaults. */
  autoCapture?: boolean | AutoCaptureConfig;
  autoRecall?: boolean;
  coreMemory?: {
    enabled?: boolean;
    /** Maximum number of core memories to load */
    maxEntries?: number;
    /** Minimum importance threshold for core memories */
    minImportance?: number;
  };
};

export const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "other",
  "core",
] as const;
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

export const memoryConfigSchema = {
  parse(value: unknown): MemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["embedding", "dbPath", "autoCapture", "autoRecall", "coreMemory"],
      "memory config",
    );

    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding.apiKey !== "string") {
      throw new Error("embedding.apiKey is required");
    }
    assertAllowedKeys(embedding, ["apiKey", "model"], "embedding config");

    const model = resolveEmbeddingModel(embedding);

    // Parse autoCapture (supports boolean for backward compat, or object for LLM config)
    let autoCapture: MemoryConfig["autoCapture"];
    if (cfg.autoCapture === false) {
      autoCapture = false;
    } else if (cfg.autoCapture === true || cfg.autoCapture === undefined) {
      // Legacy boolean or default — enable with defaults
      autoCapture = { enabled: true };
    } else if (typeof cfg.autoCapture === "object" && !Array.isArray(cfg.autoCapture)) {
      const ac = cfg.autoCapture as Record<string, unknown>;
      assertAllowedKeys(
        ac,
        ["enabled", "provider", "model", "apiKey", "baseUrl", "maxMessages"],
        "autoCapture config",
      );
      autoCapture = {
        enabled: ac.enabled !== false,
        provider:
          ac.provider === "openai" || ac.provider === "openrouter" ? ac.provider : "openrouter",
        model: typeof ac.model === "string" ? ac.model : undefined,
        apiKey: typeof ac.apiKey === "string" ? resolveEnvVars(ac.apiKey) : undefined,
        baseUrl: typeof ac.baseUrl === "string" ? ac.baseUrl : undefined,
        maxMessages: typeof ac.maxMessages === "number" ? ac.maxMessages : undefined,
      };
    }

    // Parse coreMemory
    let coreMemory: MemoryConfig["coreMemory"];
    if (cfg.coreMemory && typeof cfg.coreMemory === "object" && !Array.isArray(cfg.coreMemory)) {
      const bc = cfg.coreMemory as Record<string, unknown>;
      assertAllowedKeys(bc, ["enabled", "maxEntries", "minImportance"], "coreMemory config");
      coreMemory = {
        enabled: bc.enabled === true,
        maxEntries: typeof bc.maxEntries === "number" ? bc.maxEntries : 50,
        minImportance: typeof bc.minImportance === "number" ? bc.minImportance : 0.5,
      };
    }

    return {
      embedding: {
        provider: "openai",
        model,
        apiKey: resolveEnvVars(embedding.apiKey),
      },
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
      autoCapture: autoCapture ?? { enabled: true },
      autoRecall: cfg.autoRecall !== false,
      // Default coreMemory to enabled for consistency with autoCapture/autoRecall
      coreMemory: coreMemory ?? { enabled: true, maxEntries: 50, minImportance: 0.5 },
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
    "autoCapture.enabled": {
      label: "Auto-Capture",
      help: "Automatically capture important information from conversations using LLM extraction",
    },
    "autoCapture.provider": {
      label: "Capture LLM Provider",
      placeholder: "openrouter",
      advanced: true,
      help: "LLM provider for memory extraction (openrouter or openai)",
    },
    "autoCapture.model": {
      label: "Capture Model",
      placeholder: "google/gemini-2.0-flash-001",
      advanced: true,
      help: "LLM model for memory extraction (use a fast/cheap model)",
    },
    "autoCapture.apiKey": {
      label: "Capture API Key",
      sensitive: true,
      advanced: true,
      help: "API key for capture LLM (defaults to OpenRouter key from provider config)",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject relevant memories into context",
    },
    "coreMemory.enabled": {
      label: "Core Memory",
      help: "Inject core memories as virtual MEMORY.md at session start (replaces MEMORY.md file)",
    },
    "coreMemory.maxEntries": {
      label: "Max Core Entries",
      placeholder: "50",
      advanced: true,
      help: "Maximum number of core memories to load",
    },
    "coreMemory.minImportance": {
      label: "Min Core Importance",
      placeholder: "0.5",
      advanced: true,
      help: "Minimum importance threshold for core memories (0-1)",
    },
  },
};
