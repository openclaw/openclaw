/**
 * Redis Memory Plugin Configuration
 *
 * Handles configuration parsing and validation for the Redis memory plugin.
 * Supports multiple embedding providers: openai, gemini, local (node-llama-cpp), auto.
 */

export type EmbeddingProviderType = "openai" | "gemini" | "local" | "auto";

export type RedisMemoryConfig = {
  redis: {
    url: string;
    password?: string;
    tls?: boolean;
  };
  embedding: {
    provider: EmbeddingProviderType;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    fallback?: "openai" | "gemini" | "local" | "none";
  };
  indexName?: string;
  keyPrefix?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
};

export const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

const DEFAULT_INDEX_NAME = "idx:openclaw:memories";
const DEFAULT_KEY_PREFIX = "openclaw:memory";

// Default vector dimensions for common models
// The actual dimension is determined at runtime by the embedding provider
const DEFAULT_VECTOR_DIM = 1536;

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

export function getDefaultVectorDim(): number {
  return DEFAULT_VECTOR_DIM;
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

function resolveEnvVarsOptional(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  // Check if it contains env var syntax
  if (!value.includes("${")) {
    return value;
  }
  return value.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
    const envValue = process.env[envVar];
    // Return empty string if env var not set (optional)
    return envValue ?? "";
  });
}

export const redisMemoryConfigSchema = {
  parse(value: unknown): RedisMemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory-redis config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["redis", "embedding", "indexName", "keyPrefix", "autoCapture", "autoRecall"],
      "memory-redis config",
    );

    // Validate redis config
    const redis = cfg.redis as Record<string, unknown> | undefined;
    if (!redis || typeof redis.url !== "string") {
      throw new Error("redis.url is required");
    }
    assertAllowedKeys(redis, ["url", "password", "tls"], "redis config");

    // Validate embedding config
    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding) {
      throw new Error("embedding config is required");
    }
    assertAllowedKeys(embedding, ["provider", "apiKey", "model", "baseUrl", "fallback"], "embedding config");

    // Provider defaults to "auto" which tries local, then openai, then gemini
    const provider = (embedding.provider as EmbeddingProviderType) ?? "auto";
    const validProviders = ["openai", "gemini", "local", "auto"];
    if (!validProviders.includes(provider)) {
      throw new Error(
        `Invalid embedding provider: ${provider}. Must be one of: ${validProviders.join(", ")}`,
      );
    }

    // API key is optional for local and auto providers
    const apiKey =
      typeof embedding.apiKey === "string" ? resolveEnvVarsOptional(embedding.apiKey) : undefined;

    // For openai/gemini without auto fallback, require API key
    if ((provider === "openai" || provider === "gemini") && !apiKey) {
      throw new Error(`embedding.apiKey is required for ${provider} provider`);
    }

    const fallback = (embedding.fallback as "openai" | "gemini" | "local" | "none") ?? "none";

    return {
      redis: {
        url: resolveEnvVars(redis.url as string),
        password:
          typeof redis.password === "string" ? resolveEnvVarsOptional(redis.password) : undefined,
        tls: typeof redis.tls === "boolean" ? redis.tls : undefined,
      },
      embedding: {
        provider,
        apiKey,
        model: typeof embedding.model === "string" ? embedding.model : undefined,
        baseUrl: typeof embedding.baseUrl === "string" ? resolveEnvVarsOptional(embedding.baseUrl) : undefined,
        fallback,
      },
      indexName: typeof cfg.indexName === "string" ? cfg.indexName : DEFAULT_INDEX_NAME,
      keyPrefix: typeof cfg.keyPrefix === "string" ? cfg.keyPrefix : DEFAULT_KEY_PREFIX,
      autoCapture: typeof cfg.autoCapture === "boolean" ? cfg.autoCapture : false,
      autoRecall: typeof cfg.autoRecall === "boolean" ? cfg.autoRecall : false,
    };
  },
};
