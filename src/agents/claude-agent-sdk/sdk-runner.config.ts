/**
 * Configuration helpers for the Claude Agent SDK runner.
 *
 * Bridges Clawdbot's config system (ClawdbotConfig) to the SDK runner's
 * SdkRunnerParams, including provider environment resolution and tool
 * assembly.
 */

import type { ClawdbotConfig } from "../../config/config.js";
import type { CodingTaskToolConfig } from "../../config/types.tools.js";
import { logDebug } from "../../logger.js";
import type { SdkProviderConfig, SdkProviderEnv } from "./sdk-runner.types.js";

// ---------------------------------------------------------------------------
// Well-known providers
// ---------------------------------------------------------------------------

/** z.AI Anthropic-compatible endpoint. */
const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";
const ZAI_DEFAULT_TIMEOUT_MS = "3000000";

/**
 * Build the SDK provider config for z.AI from an API key.
 *
 * This sets the environment variables that make Claude Code talk to z.AI
 * instead of Anthropic.
 */
export function buildZaiSdkProvider(apiKey: string): SdkProviderConfig {
  return {
    name: "z.AI (GLM 4.7)",
    env: {
      ANTHROPIC_BASE_URL: ZAI_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      API_TIMEOUT_MS: ZAI_DEFAULT_TIMEOUT_MS,
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-4.7",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-4.7",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air",
    },
  };
}

/**
 * Build the SDK provider config for the default Anthropic backend.
 * No env overrides needed — uses the local Claude Code auth.
 */
export function buildAnthropicSdkProvider(): SdkProviderConfig {
  return {
    name: "Anthropic (Claude Code)",
    // No env override — uses local Claude Code credentials.
  };
}

// ---------------------------------------------------------------------------
// Config → SdkProviderConfig resolution
// ---------------------------------------------------------------------------

export type SdkProviderEntry = {
  /** Provider key (e.g., "anthropic", "zai"). */
  key: string;
  /** Resolved provider config. */
  config: SdkProviderConfig;
};

/**
 * Resolve SDK provider configurations from Clawdbot config.
 *
 * Reads from `tools.codingTask.providers` and builds SdkProviderConfig for
 * each entry. Also resolves API keys from environment variables or auth
 * profile references (${VAR_NAME} syntax).
 */
export function resolveSdkProviders(params: {
  config?: ClawdbotConfig;
  env?: NodeJS.ProcessEnv;
}): SdkProviderEntry[] {
  const codingTaskCfg = params.config?.tools?.codingTask;
  if (!codingTaskCfg) return [];

  // The config stores providers under tools.codingTask.providers.
  // Each provider has an `env` dict with potential ${VAR} references.
  const providersCfg = (
    codingTaskCfg as CodingTaskToolConfig & {
      providers?: Record<
        string,
        { env?: Record<string, string>; model?: string; maxTurns?: number }
      >;
    }
  ).providers;

  if (!providersCfg) return [];

  const processEnv = params.env ?? process.env;
  const entries: SdkProviderEntry[] = [];

  for (const [key, providerDef] of Object.entries(providersCfg)) {
    const resolvedEnv: SdkProviderEnv = {};

    if (providerDef.env) {
      for (const [envKey, envValue] of Object.entries(providerDef.env)) {
        resolvedEnv[envKey] = resolveEnvValue(envValue, processEnv);
      }
    }

    entries.push({
      key,
      config: {
        name: key,
        env: Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
        model: providerDef.model,
        maxTurns: providerDef.maxTurns,
      },
    });
  }

  return entries;
}

/**
 * Resolve a single environment variable value, expanding ${VAR} references.
 *
 * Examples:
 * - "${ZAI_API_KEY}" → process.env.ZAI_API_KEY
 * - "literal-value" → "literal-value"
 * - "${MISSING_VAR}" → "" (with debug log)
 */
function resolveEnvValue(value: string, env: NodeJS.ProcessEnv): string {
  const match = /^\$\{([A-Z0-9_]+)\}$/.exec(value.trim());
  if (!match) return value;

  const varName = match[1];
  const resolved = env[varName];
  if (resolved === undefined) {
    logDebug(`[sdk-runner.config] Environment variable ${varName} not set, using empty string`);
    return "";
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// SDK runner enablement check
// ---------------------------------------------------------------------------

/**
 * Check whether the Claude Agent SDK runner is enabled for main agent use.
 *
 * The SDK runner is enabled when:
 * 1. `tools.codingTask.enabled` is true, AND
 * 2. A provider is configured in `tools.codingTask.providers`
 *
 * This is distinct from using the `coding_task` tool (which is a Pi Agent
 * tool that wraps a single SDK query). The SDK runner replaces the Pi Agent
 * embedded runner entirely.
 */
export function isSdkRunnerEnabled(config?: ClawdbotConfig): boolean {
  const codingTaskCfg = config?.tools?.codingTask;
  if (!codingTaskCfg?.enabled) return false;

  const providersCfg = (
    codingTaskCfg as CodingTaskToolConfig & {
      providers?: Record<string, unknown>;
    }
  ).providers;

  return !!providersCfg && Object.keys(providersCfg).length > 0;
}

/**
 * Resolve the default SDK provider from config.
 *
 * Prefers "zai" if configured, otherwise the first available provider.
 * Returns undefined if no providers are configured.
 */
export function resolveDefaultSdkProvider(params: {
  config?: ClawdbotConfig;
  env?: NodeJS.ProcessEnv;
}): SdkProviderEntry | undefined {
  const providers = resolveSdkProviders(params);
  if (providers.length === 0) return undefined;

  // Prefer z.AI if configured.
  const zai = providers.find((p) => p.key === "zai");
  if (zai) return zai;

  // Prefer anthropic.
  const anthropic = providers.find((p) => p.key === "anthropic");
  if (anthropic) return anthropic;

  // Fall back to the first provider.
  return providers[0];
}
