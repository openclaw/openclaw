/**
 * Moltbot Secure - Environment-only Configuration
 *
 * All configuration via environment variables.
 * No config files, no filesystem secrets.
 */

export type SecureConfig = {
  // Telegram
  telegram: {
    botToken: string;
    allowedUsers: number[];
  };

  // AI Provider
  ai: {
    provider: "anthropic" | "openai";
    apiKey: string;
    model?: string;
  };

  // Webhooks
  webhooks: {
    enabled: boolean;
    secret: string;
    basePath: string;
  };

  // Sandbox
  sandbox: {
    enabled: boolean;
    image: string;
    network: "none" | "bridge";
    memory: string;
    cpus: string;
    timeoutMs: number;
  };

  // Scheduler
  scheduler: {
    enabled: boolean;
  };

  // Audit
  audit: {
    enabled: boolean;
    logPath: string;
  };

  // Server
  server: {
    port: number;
    host: string;
    gatewayToken: string;
  };
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function optionalBool(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  return value.toLowerCase() === "true" || value === "1";
}

function optionalInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseAllowedUsers(value: string): number[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function detectAiProvider(): { provider: "anthropic" | "openai"; apiKey: string } {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (anthropicKey) {
    return { provider: "anthropic", apiKey: anthropicKey };
  }
  if (openaiKey) {
    return { provider: "openai", apiKey: openaiKey };
  }

  throw new Error("Missing AI provider key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY");
}

function generateSecureToken(): string {
  // Generate a secure random token if not provided
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const randomValues = new Uint8Array(32);
  crypto.getRandomValues(randomValues);
  for (const byte of randomValues) {
    result += chars[byte % chars.length];
  }
  return result;
}

export function loadSecureConfig(): SecureConfig {
  // Required: Telegram
  const botToken = required("TELEGRAM_BOT_TOKEN");
  const allowedUsersRaw = required("ALLOWED_USERS");
  const allowedUsers = parseAllowedUsers(allowedUsersRaw);

  if (allowedUsers.length === 0) {
    throw new Error("ALLOWED_USERS must contain at least one valid Telegram user ID");
  }

  // Required: AI Provider
  const { provider, apiKey } = detectAiProvider();

  // Optional: Webhooks
  const webhooksEnabled = optionalBool("WEBHOOKS_ENABLED", true);
  const webhookSecret = optional("WEBHOOK_SECRET", generateSecureToken());

  // Optional: Sandbox
  const sandboxEnabled = optionalBool("SANDBOX_ENABLED", true);

  // Optional: Scheduler
  const schedulerEnabled = optionalBool("SCHEDULER_ENABLED", true);

  // Optional: Audit
  const auditEnabled = optionalBool("AUDIT_ENABLED", true);

  // Optional: Server
  const port = optionalInt("PORT", 8080);

  return {
    telegram: {
      botToken,
      allowedUsers,
    },
    ai: {
      provider,
      apiKey,
      model: process.env.AI_MODEL,
    },
    webhooks: {
      enabled: webhooksEnabled,
      secret: webhookSecret,
      basePath: optional("WEBHOOK_BASE_PATH", "/hooks"),
    },
    sandbox: {
      enabled: sandboxEnabled,
      image: optional("SANDBOX_IMAGE", "node:22-slim"),
      network: (optional("SANDBOX_NETWORK", "none") as "none" | "bridge"),
      memory: optional("SANDBOX_MEMORY", "512m"),
      cpus: optional("SANDBOX_CPUS", "1"),
      timeoutMs: optionalInt("SANDBOX_TIMEOUT_MS", 60000),
    },
    scheduler: {
      enabled: schedulerEnabled,
    },
    audit: {
      enabled: auditEnabled,
      logPath: optional("AUDIT_LOG_PATH", "/data/audit.jsonl"),
    },
    server: {
      port,
      host: optional("HOST", "0.0.0.0"),
      gatewayToken: optional("MOLTBOT_GATEWAY_TOKEN", generateSecureToken()),
    },
  };
}

/**
 * Validate config at startup and log warnings
 */
export function validateConfig(config: SecureConfig): string[] {
  const warnings: string[] = [];

  // Check for weak security settings
  if (config.sandbox.enabled && config.sandbox.network === "bridge") {
    warnings.push("SECURITY: Sandbox network is 'bridge' - containers can access network");
  }

  if (config.telegram.allowedUsers.length > 10) {
    warnings.push(`Large allowlist (${config.telegram.allowedUsers.length} users) - review if intentional`);
  }

  if (!config.audit.enabled) {
    warnings.push("SECURITY: Audit logging is disabled - no interaction records will be kept");
  }

  return warnings;
}

/**
 * Redact sensitive values for logging
 */
export function redactConfig(config: SecureConfig): Record<string, unknown> {
  return {
    telegram: {
      botToken: config.telegram.botToken.slice(0, 8) + "...",
      allowedUsers: config.telegram.allowedUsers,
    },
    ai: {
      provider: config.ai.provider,
      apiKey: config.ai.apiKey.slice(0, 8) + "...",
      model: config.ai.model,
    },
    webhooks: {
      enabled: config.webhooks.enabled,
      secret: "[REDACTED]",
      basePath: config.webhooks.basePath,
    },
    sandbox: config.sandbox,
    scheduler: config.scheduler,
    audit: config.audit,
    server: {
      port: config.server.port,
      host: config.server.host,
      gatewayToken: "[REDACTED]",
    },
  };
}
