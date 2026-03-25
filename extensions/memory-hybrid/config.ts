/**
 * Configuration Module
 *
 * Defines and validates the plugin configuration schema.
 * Supports OpenAI and Google embedding providers.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CHAT_MODELS, type ChatProvider } from "./chat.js";
import { detectProvider, vectorDimsForModel, type EmbeddingProvider } from "./embeddings.js";

// ============================================================================
// Types
// ============================================================================

export type MemoryConfig = {
  embedding: {
    provider: EmbeddingProvider;
    model: string;
    apiKey: string;
    outputDimensionality?: number;
  };
  chatModel: string;
  chatApiKey: string;
  chatProvider: ChatProvider;
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

const DEFAULT_MODEL = "text-embedding-004";
export const DEFAULT_CAPTURE_MAX_CHARS = 500;

const DEFAULT_DB_PATH = join(homedir(), ".openclaw", "memory", "lancedb");

/** Detect chat provider from chat model name */
function detectChatProvider(model: string): ChatProvider {
  if (
    model.startsWith("gpt") ||
    model.startsWith("o1-") ||
    model === "o1" ||
    model.startsWith("o3-") ||
    model === "o3"
  ) {
    return "openai";
  }
  return "google";
}

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
        "chatApiKey",
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
    assertAllowedKeys(
      embedding,
      ["apiKey", "model", "provider", "outputDimensionality"],
      "embedding config",
    );

    const model = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;

    // Validate model is supported
    vectorDimsForModel(model);

    // Bug #10: respect explicit provider if set, otherwise auto-detect from model
    const provider: EmbeddingProvider =
      typeof embedding.provider === "string" &&
      (embedding.provider === "openai" || embedding.provider === "google")
        ? (embedding.provider as EmbeddingProvider)
        : detectProvider(model);

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
      typeof cfg.chatModel === "string"
        ? cfg.chatModel
        : typeof cfg.chatApiKey === "string"
          ? // If separate chatApiKey provided, infer default model from that key's provider
            cfg.chatApiKey.startsWith("sk-") || resolveEnvVars(cfg.chatApiKey).startsWith("sk-")
            ? DEFAULT_CHAT_MODELS["openai"]
            : DEFAULT_CHAT_MODELS["google"]
          : DEFAULT_CHAT_MODELS[provider];

    // --- Chat API key (optional, defaults to embedding key) ---
    const resolvedEmbeddingApiKey = resolveEnvVars(embedding.apiKey as string);
    const chatApiKey =
      typeof cfg.chatApiKey === "string" ? resolveEnvVars(cfg.chatApiKey) : resolvedEmbeddingApiKey;

    // Detect chat provider: if separate chatApiKey looks like OpenAI key, use openai
    const hasSeparateChatKey = typeof cfg.chatApiKey === "string";
    const chatProviderHint: ChatProvider | undefined = hasSeparateChatKey
      ? chatApiKey.startsWith("sk-")
        ? "openai"
        : "google"
      : undefined;
    const chatProvider = chatProviderHint ?? detectChatProvider(chatModel);

    return {
      embedding: {
        provider,
        model,
        apiKey: resolvedEmbeddingApiKey,
        outputDimensionality:
          typeof embedding.outputDimensionality === "number"
            ? embedding.outputDimensionality
            : undefined,
      },
      chatModel,
      chatApiKey,
      chatProvider,
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
      help: "Embedding model: gemini-embedding-2-preview (Google, free, 3072 dims) or text-embedding-004 (768 dims)",
    },
    "embedding.outputDimensionality": {
      label: "Output Dimensionality",
      help: "Override model dimensions (Matryoshka). Options: 3072, 1536, 768. Recommended: 768 for efficiency.",
      advanced: true,
      placeholder: "auto",
    },
    chatModel: {
      label: "Chat Model",
      placeholder: "auto (gemma-3-27b-it / gpt-4o-mini)",
      help: "LLM for graph extraction and smart capture. Auto-detected from embedding provider if not set.",
      advanced: true,
    },
    chatApiKey: {
      label: "Chat API Key (optional)",
      sensitive: true,
      placeholder: "defaults to embedding API key",
      help: "Separate API key for chat/LLM operations. If not set, uses embedding API key.",
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
