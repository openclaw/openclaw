/**
 * Configuration schema for memory-neo4j plugin.
 *
 * Matches the JSON Schema in openclaw.plugin.json.
 * Provides runtime parsing with env var resolution and defaults.
 */

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
  autoRecall: boolean;
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

export const MEMORY_CATEGORIES = [
  "core",
  "preference",
  "fact",
  "decision",
  "entity",
  "other",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

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

export function vectorDimsForModel(model: string): number {
  // Check exact match first
  if (EMBEDDING_DIMENSIONS[model]) {
    return EMBEDDING_DIMENSIONS[model];
  }
  // Check prefix match (for versioned models like mxbai-embed-large:latest)
  for (const [known, dims] of Object.entries(EMBEDDING_DIMENSIONS)) {
    if (model.startsWith(known)) {
      return dims;
    }
  }
  // Return default for unknown models — callers should warn when this path is taken,
  // as the default 1024 dimensions may not match the actual model's output.
  return DEFAULT_EMBEDDING_DIMS;
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
  if (EMBEDDING_CONTEXT_LENGTHS[model]) {
    return EMBEDDING_CONTEXT_LENGTHS[model];
  }
  // Prefer longest matching prefix (e.g. "mxbai-embed-large-8k" over "mxbai-embed-large")
  let best: { len: number; keyLen: number } | undefined;
  for (const [known, len] of Object.entries(EMBEDDING_CONTEXT_LENGTHS)) {
    if (model.startsWith(known) && (!best || known.length > best.keyLen)) {
      best = { len, keyLen: known.length };
    }
  }
  return best?.len ?? DEFAULT_EMBEDDING_CONTEXT_LENGTH;
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
      ["embedding", "neo4j", "autoCapture", "autoRecall", "coreMemory", "extraction"],
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
    const neo4jUri = neo4jRaw.uri;
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
        ? neo4jRaw.user
        : typeof neo4jRaw.username === "string"
          ? neo4jRaw.username
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

    return {
      neo4j: {
        uri: neo4jRaw.uri,
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
      autoRecall: cfg.autoRecall !== false,
      coreMemory: {
        enabled: coreMemoryEnabled,
        maxEntries: coreMemoryMaxEntries,
        refreshAtContextPercent,
      },
    };
  },
};
