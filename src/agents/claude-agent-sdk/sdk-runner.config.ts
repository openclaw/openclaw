/**
 * Configuration helpers for the Claude Agent SDK runner.
 *
 * Bridges Clawdbrain's config system (ClawdbrainConfig) to the SDK runner's
 * SdkRunnerParams, including provider environment resolution and tool
 * assembly.
 */

import type { ClawdbrainConfig } from "../../config/config.js";
import type { SdkThinkingBudgetTier } from "../../config/types.agents.js";
import { logDebug } from "../../logger.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import type { SdkProviderConfig, SdkProviderEnv } from "./sdk-runner.types.js";
import { resolveMainAgentRuntimeKind } from "../main-agent-runtime-factory.js";

// ---------------------------------------------------------------------------
// Thinking budget tier mapping
// ---------------------------------------------------------------------------

/** Token budgets for each thinking tier. */
const THINKING_BUDGET_MAP: Record<SdkThinkingBudgetTier, number> = {
  none: 0,
  low: 10_000,
  medium: 25_000,
  high: 50_000,
};

/** Default thinking budget tier when not configured. */
const DEFAULT_THINKING_TIER: SdkThinkingBudgetTier = "medium";

/**
 * Convert a thinking budget tier to a token budget number.
 * Returns undefined if the tier is "none" (disabled).
 */
export function resolveThinkingBudget(tier?: SdkThinkingBudgetTier): number | undefined {
  const resolved = tier ?? DEFAULT_THINKING_TIER;
  const budget = THINKING_BUDGET_MAP[resolved];
  return budget === 0 ? undefined : budget;
}

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

/** OpenRouter Anthropic-compatible endpoint. */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

/**
 * Build the SDK provider config for OpenRouter.
 * API key is expected to be resolved from the auth profile store at runtime.
 */
export function buildOpenRouterSdkProvider(): SdkProviderConfig {
  return {
    name: "OpenRouter",
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE_URL,
    },
  };
}

// ---------------------------------------------------------------------------
// Well-known provider resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a well-known provider by key.
 *
 * Returns a SdkProviderEntry for the given key ("anthropic", "zai",
 * "openrouter") or undefined if the key is not recognized.
 *
 * NOTE: For providers that require an API key (z.AI, OpenRouter), the key is
 * NOT pre-filled — it must be resolved separately from the auth profile store
 * or environment at runtime.
 */
export function resolveWellKnownProvider(key: string): SdkProviderEntry | undefined {
  switch (key) {
    case "anthropic":
      return { key: "anthropic", config: buildAnthropicSdkProvider() };
    case "zai":
      return {
        key: "zai",
        config: {
          name: "z.AI (GLM 4.7)",
          env: {
            ANTHROPIC_BASE_URL: ZAI_BASE_URL,
            API_TIMEOUT_MS: ZAI_DEFAULT_TIMEOUT_MS,
            ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-4.7",
            ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-4.7",
            ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air",
          },
        },
      };
    case "openrouter":
      return { key: "openrouter", config: buildOpenRouterSdkProvider() };
    default:
      return undefined;
  }
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
 * Resolve SDK provider configurations from Clawdbrain config.
 *
 * Reads from `tools.codingTask.providers` and builds SdkProviderConfig for
 * each entry. Also resolves API keys from environment variables or auth
 * profile references (${VAR_NAME} syntax).
 */
export function resolveSdkProviders(params: {
  config?: ClawdbrainConfig;
  env?: NodeJS.ProcessEnv;
}): SdkProviderEntry[] {
  const codingTaskCfg = params.config?.tools?.codingTask;
  if (!codingTaskCfg) return [];

  // Each provider has an `env` dict with potential ${VAR} references.
  const providersCfg = codingTaskCfg.providers;

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
 * Check whether the Claude Agent SDK runner is enabled for a given agent.
 *
 * Resolution order for the main agent (agentId === "main"):
 * 1. `agents.defaults.mainRuntime` (explicit main-agent override)
 * 2. `agents.defaults.runtime` (global fallback)
 *
 * For all other agents (or when agentId is omitted):
 * 1. `agents.defaults.runtime` only
 *
 * IMPORTANT: `tools.codingTask.*` is tool-level configuration and must not
 * implicitly change the gateway-wide/main-agent runtime selection.
 */
export function isSdkRunnerEnabled(config?: ClawdbrainConfig, agentId?: string): boolean {
  const defaults = config?.agents?.defaults;
  // For the main agent (or when agentId is not provided but agents.main.runtime is set),
  // prefer mainRuntime when explicitly set.
  if (agentId && normalizeAgentId(agentId) === DEFAULT_AGENT_ID) {
    return resolveMainAgentRuntimeKind(config) === "ccsdk";
  }
  // When no agentId: check agents.main.runtime first, then fall back to agents.defaults.runtime.
  const mainRuntime = config?.agents?.main?.runtime;
  if (!agentId && mainRuntime) {
    return mainRuntime === "ccsdk";
  }
  return defaults?.runtime === "ccsdk";
}

/**
 * Resolve the default SDK provider from config.
 *
 * Resolution order for main agent (agentId === "main" or undefined):
 * 1. `agents.defaults.mainCcsdkProvider` — explicit main agent provider selection.
 * 2. `agents.defaults.ccsdkProvider` — fallback default provider.
 * 3. `tools.codingTask.providers` — legacy provider configuration fallback.
 *
 * Resolution order for worker agents (agentId !== "main"):
 * 1. `agents.defaults.ccsdkProvider` — explicit worker provider selection.
 * 2. `agents.defaults.mainCcsdkProvider` — fallback to main provider.
 * 3. `tools.codingTask.providers` — legacy provider configuration fallback.
 *
 * Within the legacy fallback, prefers "zai" if configured, then "anthropic",
 * then the first available provider.
 * Returns undefined if no providers are configured.
 */
export function resolveDefaultSdkProvider(params: {
  config?: ClawdbrainConfig;
  env?: NodeJS.ProcessEnv;
  agentId?: string;
}): SdkProviderEntry | undefined {
  const defaults = params.config?.agents?.defaults;
  const isMainAgent = !params.agentId || normalizeAgentId(params.agentId) === DEFAULT_AGENT_ID;

  // For main agent: prefer mainCcsdkProvider, then ccsdkProvider
  // For workers: prefer ccsdkProvider, then mainCcsdkProvider
  const primaryProvider = isMainAgent ? defaults?.mainCcsdkProvider : defaults?.ccsdkProvider;
  const fallbackProvider = isMainAgent ? defaults?.ccsdkProvider : defaults?.mainCcsdkProvider;

  // 1. Try primary provider for this agent type.
  if (primaryProvider) {
    const wellKnown = resolveWellKnownProvider(primaryProvider);
    if (wellKnown) return wellKnown;
  }

  // 2. Try fallback provider.
  if (fallbackProvider) {
    const wellKnown = resolveWellKnownProvider(fallbackProvider);
    if (wellKnown) return wellKnown;
  }

  // 3. Fall back to tools.codingTask.providers (existing logic).
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

// ---------------------------------------------------------------------------
// Auth profile integration
// ---------------------------------------------------------------------------

/**
 * Mapping of SDK provider keys to auth profile id prefixes.
 * Used to resolve API keys from the auth profile store when
 * `${PROFILE:zai}` syntax or implicit profile lookup is used.
 */
const PROVIDER_TO_AUTH_PROFILE: Record<string, string> = {
  zai: "zai:default",
  anthropic: "anthropic:default",
  openrouter: "openrouter:default",
};

/**
 * Resolve an API key from the auth profile store for a given SDK provider key.
 *
 * Looks up the provider's auth profile (e.g., "zai" → "zai:default") and
 * returns the stored API key if found. Returns undefined if the profile
 * doesn't exist or has no key.
 */
export function resolveApiKeyFromAuthProfile(params: {
  providerKey: string;
  store?: AuthProfileStore;
}): string | undefined {
  if (!params.store) return undefined;

  const profileId = PROVIDER_TO_AUTH_PROFILE[params.providerKey];
  if (!profileId) return undefined;

  const cred = params.store.profiles[profileId];
  if (!cred) return undefined;

  if (cred.type === "api_key") return cred.key;
  if (cred.type === "token") return cred.token;
  // OAuth tokens require async refresh — not supported in sync resolution.
  // The caller should use resolveApiKeyForProfile() for OAuth.
  return undefined;
}

/**
 * Enrich resolved SDK providers with API keys from the auth profile store.
 *
 * For each provider that uses `${PROFILE}` syntax or has an empty auth token,
 * this function looks up the corresponding auth profile and injects the key.
 * This is the bridge between the auth profile store and the SDK env config.
 */
export function enrichProvidersWithAuthProfiles(params: {
  providers: SdkProviderEntry[];
  store?: AuthProfileStore;
}): SdkProviderEntry[] {
  if (!params.store) return params.providers;

  return params.providers.map((entry) => {
    const authKey = entry.config.env?.ANTHROPIC_AUTH_TOKEN;

    // If the auth token is a ${PROFILE} reference, resolve from store.
    if (authKey === "${PROFILE}" || authKey === "") {
      const resolved = resolveApiKeyFromAuthProfile({
        providerKey: entry.key,
        store: params.store,
      });
      if (resolved) {
        return {
          ...entry,
          config: {
            ...entry.config,
            env: {
              ...entry.config.env,
              ANTHROPIC_AUTH_TOKEN: resolved,
            },
          },
        };
      }
    }

    // If no auth token at all, try implicit profile lookup.
    if (!authKey && entry.key !== "anthropic") {
      const resolved = resolveApiKeyFromAuthProfile({
        providerKey: entry.key,
        store: params.store,
      });
      if (resolved) {
        return {
          ...entry,
          config: {
            ...entry.config,
            env: {
              ...entry.config.env,
              ANTHROPIC_AUTH_TOKEN: resolved,
            },
          },
        };
      }
    }

    return entry;
  });
}
