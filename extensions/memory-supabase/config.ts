/**
 * Config schema for the memory-supabase plugin.
 *
 * Mirrors the shape of memory-lancedb's config but talks to a remote
 * Supabase project (Postgres + pgvector) instead of a local LanceDB
 * directory. All sensitive fields support `${ENV_VAR}` interpolation
 * so secrets stay in the host environment, not the JSON config.
 */

export type SupabaseMemoryConfig = {
  embedding: {
    provider: "openai";
    model: string;
    apiKey: string;
    dimensions: number;
  };
  supabase: {
    url: string;
    serviceRoleKey: string;
    userId: string;
  };
  autoIndex: boolean;
  autoRecall: boolean;
  consentDefault: boolean;
  captureMaxChars: number;
};

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_CAPTURE_MAX_CHARS = 2000;
const DEFAULT_USER_ID = "default";

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar: string) => {
    const envValue = process.env[envVar];
    if (envValue === undefined || envValue === "") {
      throw new Error(`memory-supabase: required env var ${envVar} is not set`);
    }
    return envValue;
  });
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

export const supabaseMemoryConfigSchema = {
  parse(value: unknown): SupabaseMemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory-supabase: config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      [
        "embedding",
        "supabase",
        "autoIndex",
        "autoRecall",
        "consentDefault",
        "captureMaxChars",
      ],
      "memory-supabase config",
    );

    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding.apiKey !== "string") {
      throw new Error("memory-supabase: embedding.apiKey is required");
    }
    assertAllowedKeys(embedding, ["apiKey", "model", "dimensions"], "embedding config");

    const model = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;
    const dimensions =
      typeof embedding.dimensions === "number"
        ? embedding.dimensions
        : (EMBEDDING_DIMENSIONS[model] ?? DEFAULT_DIMENSIONS);

    const supabase = cfg.supabase as Record<string, unknown> | undefined;
    if (
      !supabase ||
      typeof supabase.url !== "string" ||
      typeof supabase.serviceRoleKey !== "string"
    ) {
      throw new Error("memory-supabase: supabase.url and supabase.serviceRoleKey are required");
    }
    assertAllowedKeys(supabase, ["url", "serviceRoleKey", "userId"], "supabase config");

    const captureMaxChars =
      typeof cfg.captureMaxChars === "number"
        ? Math.floor(cfg.captureMaxChars)
        : DEFAULT_CAPTURE_MAX_CHARS;
    if (captureMaxChars < 100 || captureMaxChars > 20_000) {
      throw new Error("captureMaxChars must be between 100 and 20000");
    }

    return {
      embedding: {
        provider: "openai",
        model,
        apiKey: resolveEnvVars(embedding.apiKey),
        dimensions,
      },
      supabase: {
        url: resolveEnvVars(supabase.url),
        serviceRoleKey: resolveEnvVars(supabase.serviceRoleKey),
        userId: typeof supabase.userId === "string" ? supabase.userId : DEFAULT_USER_ID,
      },
      autoIndex: cfg.autoIndex !== false,
      autoRecall: cfg.autoRecall !== false,
      consentDefault: cfg.consentDefault !== false,
      captureMaxChars,
    };
  },
};
