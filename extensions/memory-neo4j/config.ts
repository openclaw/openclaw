/**
 * Configuration schema for memory-neo4j plugin.
 *
 * Matches the JSON Schema in openclaw.plugin.json.
 * Provides runtime parsing with env var resolution and defaults.
 */

import type { MemoryCategory } from "./schema.js";
import { MEMORY_CATEGORIES } from "./schema.js";

export type { MemoryCategory };
export { MEMORY_CATEGORIES };

export type EmbeddingProvider = "openai" | "ollama";

export type MemoryNeo4jConfig = {
  neo4j: {
    uri: string;
    username: string;
    password: string;
  };
  embedding: {
    provider: EmbeddingProvider;
    apiKey?: string;
    model: string;
    baseUrl?: string;
  };
  extraction?: {
    apiKey?: string;
    model: string;
    baseUrl: string;
  };
  autoCapture: boolean;
  autoCaptureSkipPattern?: RegExp;
  autoRecall: boolean;
  autoRecallMinScore: number;
  /**
   * RegExp pattern to skip auto-recall for matching session keys.
   * Useful for voice/realtime sessions where latency is critical.
   * Example: /voice|realtime/ skips sessions containing "voice" or "realtime".
   */
  autoRecallSkipPattern?: RegExp;
  coreMemory: {
    enabled: boolean;
    maxEntries: number;
    /**
     * Re-inject core memories when context usage reaches this percentage (0-100).
     * Helps counter "lost in the middle" phenomenon by refreshing core memories
     * closer to the end of context for recency bias.
     * Set to null/undefined to disable (default).
     */
    refreshAtContextPercent?: number;
  };
  /**
   * Maximum relationship hops for graph search spreading activation.
   * Default: 1 (direct + 1-hop neighbors).
   * Setting to 2+ enables deeper traversal but may slow queries.
   */
  graphSearchDepth: number;
  /**
   * Per-category decay curve parameters. Each category can have its own
   * half-life (days) controlling how fast memories in that category decay.
   * Categories not listed use the sleep cycle's default (30 days).
   */
  decayCurves: Record<string, { halfLifeDays: number }>;
};

/**
 * Extraction configuration resolved from environment variables.
 * Entity extraction auto-enables when OPENROUTER_API_KEY is set.
 */
export type ExtractionConfig = {
  enabled: boolean;
  apiKey: string;
  model: string;
  baseUrl: string;
  temperature: number;
  maxRetries: number;
};

export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  // OpenAI models
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  // Ollama models (common ones)
  "mxbai-embed-large": 1024,
  "mxbai-embed-large-2k:latest": 1024,
  "nomic-embed-text": 768,
  "all-minilm": 384,
};

// Default dimension for unknown models (Ollama models vary)
export const DEFAULT_EMBEDDING_DIMS = 1024;

/**
 * Lookup a value by exact key or longest matching prefix.
 * Returns undefined if no match found.
 */
function lookupByPrefix<T>(table: Record<string, T>, key: string): T | undefined {
  if (table[key] !== undefined) {
    return table[key];
  }
  let best: { value: T; keyLen: number } | undefined;
  for (const [known, value] of Object.entries(table)) {
    if (key.startsWith(known) && (!best || known.length > best.keyLen)) {
      best = { value, keyLen: known.length };
    }
  }
  return best?.value;
}

export function vectorDimsForModel(model: string): number {
  // Return default for unknown models — callers should warn when this path is taken,
  // as the default 1024 dimensions may not match the actual model's output.
  return lookupByPrefix(EMBEDDING_DIMENSIONS, model) ?? DEFAULT_EMBEDDING_DIMS;
}

/** Max input token lengths for known embedding models. */
export const EMBEDDING_CONTEXT_LENGTHS: Record<string, number> = {
  // OpenAI models
  "text-embedding-3-small": 8191,
  "text-embedding-3-large": 8191,
  // Ollama models
  "mxbai-embed-large": 512,
  "mxbai-embed-large-2k": 2048,
  "mxbai-embed-large-8k": 8192,
  "nomic-embed-text": 8192,
  "all-minilm": 256,
};

/** Conservative default for unknown models. */
export const DEFAULT_EMBEDDING_CONTEXT_LENGTH = 512;

export function contextLengthForModel(model: string): number {
  return lookupByPrefix(EMBEDDING_CONTEXT_LENGTHS, model) ?? DEFAULT_EMBEDDING_CONTEXT_LENGTH;
}

/**
 * Resolve ${ENV_VAR} references in string values.
 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

/**
 * Resolve extraction config from plugin config with env var fallback.
 * Enabled when an API key is available (cloud) or a baseUrl is explicitly
 * configured (Ollama / local LLMs that don't need a key).
 */
export function resolveExtractionConfig(
  cfgExtraction?: MemoryNeo4jConfig["extraction"],
): ExtractionConfig {
  const apiKey = cfgExtraction?.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
  const model =
    cfgExtraction?.model ?? process.env.EXTRACTION_MODEL ?? "google/gemini-2.0-flash-001";
  const baseUrl =
    cfgExtraction?.baseUrl ?? process.env.EXTRACTION_BASE_URL ?? "https://openrouter.ai/api/v1";
  // Enabled when an API key is set (cloud provider) or baseUrl was explicitly
  // configured in the plugin config (Ollama / local — no key needed).
  const enabled = apiKey.length > 0 || cfgExtraction?.baseUrl != null;
  return {
    enabled,
    apiKey,
    model,
    baseUrl,
    temperature: 0.0,
    maxRetries: 2,
  };
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

/** Parse autoRecallMinScore: must be a number between 0 and 1, default 0.25. */
function parseAutoRecallMinScore(value: unknown): number {
  if (typeof value !== "number") return 0.25;
  if (value < 0 || value > 1) {
    throw new Error(`autoRecallMinScore must be between 0 and 1, got: ${value}`);
  }
  return value;
}

/**
 * Config schema with parse method for runtime validation & transformation.
 * JSON Schema validation is handled by openclaw.plugin.json; this handles
 * env var resolution and defaults.
 */
export const memoryNeo4jConfigSchema = {
  parse(value: unknown): MemoryNeo4jConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory-neo4j config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      [
        "embedding",
        "neo4j",
        "autoCapture",
        "autoCaptureSkipPattern",
        "autoRecall",
        "autoRecallMinScore",
        "autoRecallSkipPattern",
        "coreMemory",
        "extraction",
        "graphSearchDepth",
        "decayCurves",
      ],
      "memory-neo4j config",
    );

    // Parse neo4j section
    const neo4jRaw = cfg.neo4j as Record<string, unknown> | undefined;
    if (!neo4jRaw || typeof neo4jRaw !== "object") {
      throw new Error("neo4j config section is required");
    }
    assertAllowedKeys(neo4jRaw, ["uri", "user", "username", "password"], "neo4j config");
    if (typeof neo4jRaw.uri !== "string" || !neo4jRaw.uri) {
      throw new Error("neo4j.uri is required");
    }
    const neo4jUri = resolveEnvVars(neo4jRaw.uri);
    // Validate URI scheme — must be a valid Neo4j connection protocol
    const VALID_NEO4J_SCHEMES = [
      "bolt://",
      "bolt+s://",
      "bolt+ssc://",
      "neo4j://",
      "neo4j+s://",
      "neo4j+ssc://",
    ];
    if (!VALID_NEO4J_SCHEMES.some((scheme) => neo4jUri.startsWith(scheme))) {
      throw new Error(
        `neo4j.uri must start with a valid scheme (${VALID_NEO4J_SCHEMES.join(", ")}), got: "${neo4jUri}"`,
      );
    }

    const neo4jPassword =
      typeof neo4jRaw.password === "string" ? resolveEnvVars(neo4jRaw.password) : "";
    // Support both 'user' and 'username' for neo4j config
    const neo4jUsername =
      typeof neo4jRaw.user === "string"
        ? resolveEnvVars(neo4jRaw.user)
        : typeof neo4jRaw.username === "string"
          ? resolveEnvVars(neo4jRaw.username)
          : "neo4j";

    // Parse embedding section (optional for ollama without apiKey)
    const embeddingRaw = cfg.embedding as Record<string, unknown> | undefined;
    assertAllowedKeys(
      embeddingRaw ?? {},
      ["provider", "apiKey", "model", "baseUrl"],
      "embedding config",
    );

    const provider: EmbeddingProvider = embeddingRaw?.provider === "ollama" ? "ollama" : "openai";

    // apiKey is required for openai, optional for ollama
    let apiKey: string | undefined;
    if (typeof embeddingRaw?.apiKey === "string" && embeddingRaw.apiKey) {
      apiKey = resolveEnvVars(embeddingRaw.apiKey);
    } else if (provider === "openai") {
      throw new Error("embedding.apiKey is required for OpenAI provider");
    }

    const embeddingModel =
      typeof embeddingRaw?.model === "string"
        ? embeddingRaw.model
        : provider === "ollama"
          ? "mxbai-embed-large"
          : "text-embedding-3-small";

    const baseUrl = typeof embeddingRaw?.baseUrl === "string" ? embeddingRaw.baseUrl : undefined;

    // Parse coreMemory section (optional with defaults)
    const coreMemoryRaw = cfg.coreMemory as Record<string, unknown> | undefined;
    assertAllowedKeys(
      coreMemoryRaw ?? {},
      ["enabled", "maxEntries", "refreshAtContextPercent"],
      "coreMemory config",
    );
    const coreMemoryEnabled = coreMemoryRaw?.enabled !== false; // enabled by default
    const coreMemoryMaxEntries =
      typeof coreMemoryRaw?.maxEntries === "number" ? coreMemoryRaw.maxEntries : 50;
    if (coreMemoryMaxEntries <= 0) {
      throw new Error(`coreMemory.maxEntries must be greater than 0, got: ${coreMemoryMaxEntries}`);
    }
    // refreshAtContextPercent: number between 1-99 to be effective, or undefined to disable.
    // Values at 0 or below are ignored (disables refresh). Values above 100 are invalid.
    if (
      typeof coreMemoryRaw?.refreshAtContextPercent === "number" &&
      coreMemoryRaw.refreshAtContextPercent > 100
    ) {
      throw new Error(
        `coreMemory.refreshAtContextPercent must be between 1 and 100, got: ${coreMemoryRaw.refreshAtContextPercent}`,
      );
    }
    const refreshAtContextPercent =
      typeof coreMemoryRaw?.refreshAtContextPercent === "number" &&
      coreMemoryRaw.refreshAtContextPercent > 0 &&
      coreMemoryRaw.refreshAtContextPercent <= 100
        ? coreMemoryRaw.refreshAtContextPercent
        : undefined;

    // Parse extraction section (optional — falls back to env vars in resolveExtractionConfig)
    const extractionRaw = cfg.extraction as Record<string, unknown> | undefined;
    assertAllowedKeys(extractionRaw ?? {}, ["apiKey", "model", "baseUrl"], "extraction config");
    let extraction: MemoryNeo4jConfig["extraction"];
    if (extractionRaw) {
      const exApiKey =
        typeof extractionRaw.apiKey === "string" ? resolveEnvVars(extractionRaw.apiKey) : undefined;
      const exModel = typeof extractionRaw.model === "string" ? extractionRaw.model : undefined;
      const exBaseUrl =
        typeof extractionRaw.baseUrl === "string" ? extractionRaw.baseUrl : undefined;
      // Only include if at least one field was provided
      if (exApiKey || exModel || exBaseUrl) {
        extraction = {
          apiKey: exApiKey,
          model: exModel ?? (process.env.EXTRACTION_MODEL || "google/gemini-2.0-flash-001"),
          baseUrl: exBaseUrl ?? (process.env.EXTRACTION_BASE_URL || "https://openrouter.ai/api/v1"),
        };
      }
    }

    // Parse decayCurves: per-category decay curve overrides
    const decayCurvesRaw = cfg.decayCurves as Record<string, unknown> | undefined;
    const decayCurves: Record<string, { halfLifeDays: number }> = {};
    if (decayCurvesRaw && typeof decayCurvesRaw === "object") {
      for (const [cat, val] of Object.entries(decayCurvesRaw)) {
        if (val && typeof val === "object" && "halfLifeDays" in val) {
          const hl = (val as Record<string, unknown>).halfLifeDays;
          if (typeof hl === "number" && hl > 0) {
            decayCurves[cat] = { halfLifeDays: hl };
          } else {
            throw new Error(`decayCurves.${cat}.halfLifeDays must be a positive number`);
          }
        }
      }
    }

    // Parse graphSearchDepth: must be 1-3, default 1
    const rawDepth = cfg.graphSearchDepth;
    let graphSearchDepth = 1;
    if (typeof rawDepth === "number") {
      if (rawDepth < 1 || rawDepth > 3 || !Number.isInteger(rawDepth)) {
        throw new Error(`graphSearchDepth must be 1, 2, or 3, got: ${rawDepth}`);
      }
      graphSearchDepth = rawDepth;
    }

    return {
      neo4j: {
        uri: neo4jUri,
        username: neo4jUsername,
        password: neo4jPassword,
      },
      embedding: {
        provider,
        apiKey,
        model: embeddingModel,
        baseUrl,
      },
      extraction,
      autoCapture: cfg.autoCapture !== false,
      autoCaptureSkipPattern:
        typeof cfg.autoCaptureSkipPattern === "string" && cfg.autoCaptureSkipPattern
          ? new RegExp(cfg.autoCaptureSkipPattern)
          : undefined,
      autoRecall: cfg.autoRecall !== false,
      autoRecallMinScore: parseAutoRecallMinScore(cfg.autoRecallMinScore),
      autoRecallSkipPattern:
        typeof cfg.autoRecallSkipPattern === "string" && cfg.autoRecallSkipPattern
          ? new RegExp(cfg.autoRecallSkipPattern)
          : undefined,
      coreMemory: {
        enabled: coreMemoryEnabled,
        maxEntries: coreMemoryMaxEntries,
        refreshAtContextPercent,
      },
      graphSearchDepth,
      decayCurves,
    };
  },
};
