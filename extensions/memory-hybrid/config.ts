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

const DEFAULT_MODEL = "gemini-embedding-001";
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
    let chatModel: string;
    if (typeof cfg.chatModel === "string") {
      chatModel = cfg.chatModel;
    } else if (typeof cfg.chatApiKey === "string") {
      // If separate chatApiKey provided, infer default model from that key's provider
      let looksLikeOpenAI = cfg.chatApiKey.startsWith("sk-");
      if (!looksLikeOpenAI) {
        try {
          looksLikeOpenAI = resolveEnvVars(cfg.chatApiKey).startsWith("sk-");
        } catch {
          // Env var not set yet — default to google
        }
      }
      chatModel = looksLikeOpenAI ? DEFAULT_CHAT_MODELS["openai"] : DEFAULT_CHAT_MODELS["google"];
    } else {
      chatModel = DEFAULT_CHAT_MODELS[provider];
    }

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

  safeParse(value: unknown): {
    success: boolean;
    data?: MemoryConfig;
    error?: { issues: Array<{ path: Array<string | number>; message: string }> };
  } {
    try {
      const data = this.parse(value);
      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        error: {
          issues: [{ path: [], message: err instanceof Error ? err.message : String(err) }],
        },
      };
    }
  },
};
