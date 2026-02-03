/**
 * Configuration schema for memory-neo4j plugin.
 *
 * Matches the JSON Schema in openclaw.plugin.json.
 * Provides runtime parsing with env var resolution and defaults.
 */

export type MemoryNeo4jConfig = {
  neo4j: {
    uri: string;
    username: string;
    password: string;
  };
  embedding: {
    apiKey: string;
    model: "text-embedding-3-small" | "text-embedding-3-large";
  };
  autoCapture: boolean;
  autoRecall: boolean;
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

export const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

export function vectorDimsForModel(model: string): number {
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(
      `Unsupported embedding model: ${model}. Supported: ${Object.keys(EMBEDDING_DIMENSIONS).join(", ")}`,
    );
  }
  return dims;
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
 * Resolve extraction config from environment variables.
 * Returns enabled: false if OPENROUTER_API_KEY is not set.
 */
export function resolveExtractionConfig(): ExtractionConfig {
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  return {
    enabled: apiKey.length > 0,
    apiKey,
    model: process.env.EXTRACTION_MODEL ?? "google/gemini-2.0-flash-001",
    baseUrl: process.env.EXTRACTION_BASE_URL ?? "https://openrouter.ai/api/v1",
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
      ["embedding", "neo4j", "autoCapture", "autoRecall"],
      "memory-neo4j config",
    );

    // Parse neo4j section
    const neo4jRaw = cfg.neo4j as Record<string, unknown> | undefined;
    if (!neo4jRaw || typeof neo4jRaw !== "object") {
      throw new Error("neo4j config section is required");
    }
    assertAllowedKeys(neo4jRaw, ["uri", "username", "password"], "neo4j config");
    if (typeof neo4jRaw.uri !== "string" || !neo4jRaw.uri) {
      throw new Error("neo4j.uri is required");
    }

    const neo4jPassword =
      typeof neo4jRaw.password === "string" ? resolveEnvVars(neo4jRaw.password) : "";
    const neo4jUsername = typeof neo4jRaw.username === "string" ? neo4jRaw.username : "neo4j";

    // Parse embedding section
    const embeddingRaw = cfg.embedding as Record<string, unknown> | undefined;
    if (!embeddingRaw || typeof embeddingRaw !== "object") {
      throw new Error("embedding config section is required");
    }
    assertAllowedKeys(embeddingRaw, ["apiKey", "model"], "embedding config");
    if (typeof embeddingRaw.apiKey !== "string" || !embeddingRaw.apiKey) {
      throw new Error("embedding.apiKey is required");
    }

    const embeddingModel =
      typeof embeddingRaw.model === "string" ? embeddingRaw.model : "text-embedding-3-small";
    // Validate model is supported
    vectorDimsForModel(embeddingModel);

    return {
      neo4j: {
        uri: neo4jRaw.uri,
        username: neo4jUsername,
        password: neo4jPassword,
      },
      embedding: {
        apiKey: resolveEnvVars(embeddingRaw.apiKey),
        model: embeddingModel,
      },
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
    };
  },
};
