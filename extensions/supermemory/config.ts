export type SupermemoryConfig = {
  apiKey: string;
  /** Optional static user ID for containerTag. Falls back to requesterSenderId / agentId. */
  userId?: string;
};

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
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

export const supermemoryConfigSchema = {
  parse(value: unknown): SupermemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("supermemory config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(cfg, ["apiKey", "userId"], "supermemory config");

    if (typeof cfg.apiKey !== "string" || !cfg.apiKey) {
      throw new Error("apiKey is required");
    }

    return {
      apiKey: resolveEnvVars(cfg.apiKey),
      userId: typeof cfg.userId === "string" ? cfg.userId : undefined,
    };
  },
  uiHints: {
    apiKey: {
      label: "Supermemory API Key",
      sensitive: true,
      placeholder: "sm_...",
      help: "API key from console.supermemory.ai (or use ${SUPERMEMORY_API_KEY})",
    },
    userId: {
      label: "User ID",
      placeholder: "user-123",
      help: "Optional static containerTag (default: requesterSenderId or agentId)",
      advanced: true,
    },
  },
};
