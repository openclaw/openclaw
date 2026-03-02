/**
 * Configuration Module
 *
 * Defines and validates the plugin configuration schema.
 * Supports OpenAI and Google embedding providers.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CHAT_MODELS } from "./chat.js";
import { detectProvider, vectorDimsForModel, type EmbeddingProvider } from "./embeddings.js";

// ============================================================================
// Types
// ============================================================================

export type MemoryConfig = {
  embedding: {
    provider: EmbeddingProvider;
    model: string;
    apiKey: string;
  };
  chatModel: string;
  dbPath: string;
  autoCapture: boolean;
  autoRecall: boolean;
  smartCapture: boolean;
  captureMaxChars: number;
};

export const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_MODEL = "gemini-embedding-001";
export const DEFAULT_CAPTURE_MAX_CHARS = 500;

function resolveDefaultDbPath(): string {
  const home = homedir();
  const preferred = join(home, ".openclaw", "memory", "lancedb");
  try {
    if (fs.existsSync(preferred)) return preferred;
  } catch {
    // best-effort
  }
  return preferred;
}

const DEFAULT_DB_PATH = resolveDefaultDbPath();

// ============================================================================
// Helpers
// ============================================================================

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
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

// ============================================================================
// Config Schema
// ============================================================================

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
        "chatModel",
        "dbPath",
        "autoCapture",
        "autoRecall",
        "smartCapture",
        "captureMaxChars",
      ],
      "memory config",
    );

    // --- Embedding config ---
    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding.apiKey !== "string") {
      throw new Error("embedding.apiKey is required");
    }
    assertAllowedKeys(embedding, ["apiKey", "model", "provider"], "embedding config");

    const model = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;

    // Validate model is supported
    vectorDimsForModel(model);

    const provider = detectProvider(model);

    // --- Capture max chars ---
    const captureMaxChars =
      typeof cfg.captureMaxChars === "number" ? Math.floor(cfg.captureMaxChars) : undefined;
    if (
      typeof captureMaxChars === "number" &&
      (captureMaxChars < 100 || captureMaxChars > 10_000)
    ) {
      throw new Error("captureMaxChars must be between 100 and 10000");
    }

    // --- Chat model ---
    const chatModel =
      typeof cfg.chatModel === "string" ? cfg.chatModel : DEFAULT_CHAT_MODELS[provider];

    return {
      embedding: {
        provider,
        model,
        apiKey: resolveEnvVars(embedding.apiKey),
      },
      chatModel,
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
      autoCapture: cfg.autoCapture === true,
      autoRecall: cfg.autoRecall !== false,
      smartCapture: cfg.smartCapture === true,
      captureMaxChars: captureMaxChars ?? DEFAULT_CAPTURE_MAX_CHARS,
    };
  },

  uiHints: {
    "embedding.apiKey": {
      label: "API Key",
      sensitive: true,
      placeholder: "sk-proj-... or AIzaSy...",
      help: "API key for embeddings. Supports OpenAI and Google Gemini (use ${GEMINI_API_KEY} for env var)",
    },
    "embedding.model": {
      label: "Embedding Model",
      placeholder: DEFAULT_MODEL,
      help: "Embedding model: gemini-embedding-001 (Google, free) or text-embedding-3-small (OpenAI)",
    },
    chatModel: {
      label: "Chat Model",
      placeholder: "auto (gemma-3-27b-it / gpt-4o-mini)",
      help: "LLM for graph extraction and smart capture. Auto-detected from embedding provider if not set.",
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
    smartCapture: {
      label: "Smart Capture (LLM)",
      help: "Use LLM to intelligently extract facts (uses 1 API call per message, more accurate than regex)",
      advanced: true,
    },
    captureMaxChars: {
      label: "Capture Max Chars",
      help: "Maximum message length eligible for auto-capture",
      advanced: true,
      placeholder: String(DEFAULT_CAPTURE_MAX_CHARS),
    },
  },
};
