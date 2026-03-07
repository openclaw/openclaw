/**
 * Email Listener Skill - Configuration Module
 *
 * Handles loading and validating configuration for the email listener.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EmailListenerConfig, ImapConfig, SecurityConfig, PollingConfig, AgentConfig, CleanupConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { logger } from "./logger.js";

const CONFIG_ENV_VAR_PREFIX = "FRANKOS_EMAIL_";

/**
 * Load configuration from file and environment variables
 */
export async function loadConfig(configPath?: string): Promise<EmailListenerConfig> {
  const config: EmailListenerConfig = {
    imap: loadImapConfig(),
    security: loadSecurityConfig(),
    polling: loadPollingConfig(),
    commands: loadCommandConfig(),
    agent: loadAgentConfig(),
    cleanup: loadCleanupConfig(),
  };

  // Override with file config if provided
  if (configPath) {
    try {
      const fileContent = await readFile(configPath, "utf-8");
      const fileConfig = JSON.parse(fileContent) as Partial<EmailListenerConfig>;
      Object.assign(config, fileConfig);
      logger.info("Loaded configuration from file", { path: configPath });
    } catch (error) {
      logger.warn("Failed to load config file, using defaults", { path: configPath, error });
    }
  }

  // Validate configuration
  validateConfig(config);

  return config;
}

/**
 * Load IMAP configuration from environment variables
 */
function loadImapConfig(): ImapConfig {
  return {
    host: getEnv("IMAP_HOST", "imap.example.com"),
    port: parseInt(getEnv("IMAP_PORT", "993"), 10),
    secure: getEnv("IMAP_SECURE", "true").toLowerCase() === "true",
    user: getEnv("IMAP_USER", ""),
    password: getEnv("IMAP_PASSWORD", ""),
  };
}

/**
 * Load security configuration from environment variables
 */
function loadSecurityConfig(): SecurityConfig {
  const allowedSenders = getEnv("ALLOWED_SENDERS", "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const requireConfirmation = getEnv("REQUIRE_CONFIRMATION", "DELETE,RESTART,SHUTDOWN")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    allowedSenders,
    requireConfirmation,
    confirmationTimeout: parseInt(getEnv("CONFIRMATION_TIMEOUT", "300000"), 10),
  };
}

/**
 * Load polling configuration from environment variables
 */
function loadPollingConfig(): PollingConfig {
  return {
    intervalMs: parseInt(getEnv("POLLING_INTERVAL", "300000"), 10),
    enabled: getEnv("POLLING_ENABLED", "true").toLowerCase() === "true",
  };
}

/**
 * Load agent configuration from environment variables
 */
function loadAgentConfig(): AgentConfig {
  return {
    agentName: getEnv("AGENT_NAME", "tim"),
    enableFreeform: getEnv("ENABLE_FREEFORM", "true").toLowerCase() === "true",
    messageTimeoutMs: parseInt(getEnv("MESSAGE_TIMEOUT", "120000"), 10),
  };
}

/**
 * Load cleanup configuration from environment variables
 */
function loadCleanupConfig(): CleanupConfig {
  return {
    enabled: getEnv("CLEANUP_ENABLED", "false").toLowerCase() === "true",
    intervalMs: parseInt(getEnv("CLEANUP_INTERVAL", "3600000"), 10), // 1 hour
    retentionPeriodMs: parseInt(getEnv("CLEANUP_RETENTION", "86400000"), 10), // 24 hours
    action: getEnv("CLEANUP_ACTION", "trash") as "trash" | "delete",
  };
}

const enabled = getEnv("ENABLED_COMMANDS", "STATUS,SECURITY_AUDIT,CHECK_UPDATES,MEMORY_COMPACT,AGENT_STATUS")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const disabled = getEnv("DISABLED_COMMANDS", "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return { enabled, disabled };
}

/**
 * Get environment variable with prefix
 */
function getEnv(name: string, defaultValue: string): string {
  const fullName = `${CONFIG_ENV_VAR_PREFIX}${name}`;
  return process.env[fullName] ?? process.env[name] ?? defaultValue;
}

/**
 * Validate configuration
 */
function validateConfig(config: EmailListenerConfig): void {
  // Validate IMAP config
  if (!config.imap.host) {
    throw new Error("IMAP host is required");
  }

  if (!config.imap.user) {
    throw new Error("IMAP user is required");
  }

  if (!config.imap.password) {
    throw new Error("IMAP password is required");
  }

  // Validate security config
  if (config.security.allowedSenders.length === 0) {
    logger.warn("No allowed senders configured - all emails will be rejected");
  }

  // Validate polling config
  if (config.polling.intervalMs < 10000) {
    logger.warn("Polling interval is less than 10 seconds - this may cause performance issues");
  }
}

/**
 * Get configuration schema for documentation
 */
export function getConfigSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      imap: {
        type: "object",
        properties: {
          host: {
            type: "string",
            description: "IMAP server hostname",
            example: "imap.gmail.com",
          },
          port: {
            type: "number",
            description: "IMAP server port",
            example: 993,
          },
          secure: {
            type: "boolean",
            description: "Use TLS/SSL",
            example: true,
          },
          user: {
            type: "string",
            description: "IMAP username (email address)",
            example: "tim@frankos.local",
          },
          password: {
            type: "string",
            description: "IMAP password or app-specific password",
            example: "xxxx xxxx xxxx xxxx",
          },
        },
        required: ["host", "user", "password"],
      },
      security: {
        type: "object",
        properties: {
          allowedSenders: {
            type: "array",
            items: { type: "string" },
            description: "List of allowed sender email addresses",
            example: ["admin@frankos.local", "owner@example.com"],
          },
          requireConfirmation: {
            type: "array",
            items: { type: "string" },
            description: "Commands that require explicit confirmation",
            example: ["DELETE", "RESTART", "SHUTDOWN"],
          },
          confirmationTimeout: {
            type: "number",
            description: "Confirmation timeout in milliseconds",
            example: 300000,
          },
        },
      },
      polling: {
        type: "object",
        properties: {
          intervalMs: {
            type: "number",
            description: "Polling interval in milliseconds",
            example: 300000,
          },
          enabled: {
            type: "boolean",
            description: "Whether polling is enabled",
            example: true,
          },
        },
      },
    },
  };
}
