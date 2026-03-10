/**
 * Episode Memory Plugin Configuration
 *
 * Parses and validates plugin config with sensible defaults.
 * Follows the same manual-parse pattern as memory-lancedb/config.ts.
 */

export type EpisodesConfig = {
  postgres: {
    connectionString: string;
  };
  embedding: {
    baseUrl: string;
    model: string;
    dimensions: number;
  };
  extraction: {
    model: string;
    baseUrl: string;
    apiKey: string;
    maxSummaryTokens: number;
  };
  retrieval: {
    maxResults: number;
    maxTokens: number;
    similarityThreshold: number;
    maxAgeDays: number;
    preferSameChannel: boolean;
  };
  retention: {
    enabled: boolean;
    maxAgeDays: number;
  };
  mem0: {
    baseUrl: string;
    enabled: boolean;
  };
};

const DEFAULTS = {
  embedding: {
    baseUrl: "http://127.0.0.1:11434",
    model: "nomic-embed-text",
    dimensions: 768,
  },
  extraction: {
    model: "deepseek/deepseek-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    maxSummaryTokens: 500,
  },
  retrieval: {
    maxResults: 3,
    maxTokens: 2000,
    similarityThreshold: 0.3,
    maxAgeDays: 30,
    preferSameChannel: true,
  },
  retention: {
    enabled: false,
    maxAgeDays: 90,
  },
  mem0: {
    baseUrl: "http://127.0.0.1:8420",
    enabled: true,
  },
} as const;

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar: string) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function assertIsObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  return typeof val === "string" ? val : undefined;
}

function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const val = obj[key];
  return typeof val === "number" ? val : undefined;
}

function optionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const val = obj[key];
  return typeof val === "boolean" ? val : undefined;
}

export function parseConfig(value: unknown): EpisodesConfig {
  assertIsObject(value, "episodes config");
  const cfg = value as Record<string, unknown>;

  // postgres (required)
  assertIsObject(cfg.postgres, "postgres config");
  const pg = cfg.postgres as Record<string, unknown>;
  if (typeof pg.connectionString !== "string") {
    throw new Error("postgres.connectionString is required");
  }

  // embedding (optional block — defaults to local Ollama)
  const emb = (cfg.embedding ?? {}) as Record<string, unknown>;
  if (cfg.embedding !== undefined) {
    assertIsObject(cfg.embedding, "embedding config");
  }

  // extraction (optional block)
  const ext = (cfg.extraction ?? {}) as Record<string, unknown>;
  if (cfg.extraction !== undefined) {
    assertIsObject(cfg.extraction, "extraction config");
  }

  // retrieval (optional block)
  const ret = (cfg.retrieval ?? {}) as Record<string, unknown>;
  if (cfg.retrieval !== undefined) {
    assertIsObject(cfg.retrieval, "retrieval config");
  }

  // retention (optional block)
  const rtn = (cfg.retention ?? {}) as Record<string, unknown>;
  if (cfg.retention !== undefined) {
    assertIsObject(cfg.retention, "retention config");
  }

  // mem0 (optional block)
  const m0 = (cfg.mem0 ?? {}) as Record<string, unknown>;
  if (cfg.mem0 !== undefined) {
    assertIsObject(cfg.mem0, "mem0 config");
  }

  return {
    postgres: {
      connectionString: resolveEnvVars(pg.connectionString as string),
    },
    embedding: {
      baseUrl: optionalString(emb, "baseUrl")
        ? resolveEnvVars(optionalString(emb, "baseUrl")!)
        : DEFAULTS.embedding.baseUrl,
      model: optionalString(emb, "model") ?? DEFAULTS.embedding.model,
      dimensions: optionalNumber(emb, "dimensions") ?? DEFAULTS.embedding.dimensions,
    },
    extraction: {
      model: optionalString(ext, "model") ?? DEFAULTS.extraction.model,
      baseUrl: optionalString(ext, "baseUrl")
        ? resolveEnvVars(optionalString(ext, "baseUrl")!)
        : DEFAULTS.extraction.baseUrl,
      apiKey: optionalString(ext, "apiKey")
        ? resolveEnvVars(optionalString(ext, "apiKey")!)
        : (process.env.OPENROUTER_API_KEY ?? ""),
      maxSummaryTokens:
        optionalNumber(ext, "maxSummaryTokens") ?? DEFAULTS.extraction.maxSummaryTokens,
    },
    retrieval: {
      maxResults: optionalNumber(ret, "maxResults") ?? DEFAULTS.retrieval.maxResults,
      maxTokens: optionalNumber(ret, "maxTokens") ?? DEFAULTS.retrieval.maxTokens,
      similarityThreshold:
        optionalNumber(ret, "similarityThreshold") ?? DEFAULTS.retrieval.similarityThreshold,
      maxAgeDays: optionalNumber(ret, "maxAgeDays") ?? DEFAULTS.retrieval.maxAgeDays,
      preferSameChannel:
        optionalBoolean(ret, "preferSameChannel") ?? DEFAULTS.retrieval.preferSameChannel,
    },
    retention: {
      enabled: optionalBoolean(rtn, "enabled") ?? DEFAULTS.retention.enabled,
      maxAgeDays: optionalNumber(rtn, "maxAgeDays") ?? DEFAULTS.retention.maxAgeDays,
    },
    mem0: {
      baseUrl: optionalString(m0, "baseUrl") ?? DEFAULTS.mem0.baseUrl,
      enabled: optionalBoolean(m0, "enabled") ?? DEFAULTS.mem0.enabled,
    },
  };
}
