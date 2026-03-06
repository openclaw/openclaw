// Lazy-load pi-coding-agent model metadata so we can infer context windows when
// the agent reports a model id. This includes custom models.json entries.

import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { computeBackoff, type BackoffPolicy } from "../infra/backoff.js";
import { consumeRootOptionToken, FLAG_TERMINATOR } from "../infra/cli-root-options.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

type ModelEntry = { id: string; provider: string; contextWindow?: number };
type ModelRegistryLike = {
  getAvailable?: () => ModelEntry[];
  getAll: () => ModelEntry[];
};
type ConfigModelEntry = { id?: string; contextWindow?: number };
type ProviderConfigEntry = { models?: ConfigModelEntry[] };
type ModelsConfig = { providers?: Record<string, ProviderConfigEntry | undefined> };
type AgentModelEntry = { params?: Record<string, unknown> };

const ANTHROPIC_1M_MODEL_PREFIXES = ["claude-opus-4", "claude-sonnet-4"] as const;
export const ANTHROPIC_CONTEXT_1M_TOKENS = 1_048_576;

function normalizeModelId(modelId: string): string {
  const normalized = modelId.toLowerCase().trim();
  const slashIndex = normalized.indexOf("/");
  if (slashIndex >= 0) {
    return normalized.slice(slashIndex + 1);
  }
  return normalized;
}
const CONFIG_LOAD_RETRY_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0,
};

export function applyDiscoveredContextWindows(params: {
  cache: Map<string, number>;
  models: ModelEntry[];
}) {
  for (const model of params.models) {
    if (!model?.id || !model?.provider) {
      continue;
    }
    const contextWindow =
      typeof model.contextWindow === "number" ? Math.trunc(model.contextWindow) : undefined;
    if (!contextWindow || contextWindow <= 0) {
      continue;
    }

    const normalizedModelId = normalizeModelId(model.id);

    // 1. Scoped lookup (highest precedence)
    const scopedKey = `${model.provider.toLowerCase().trim()}::${normalizedModelId}`;
    const existingScoped = params.cache.get(scopedKey);
    if (existingScoped === undefined || contextWindow < existingScoped) {
      params.cache.set(scopedKey, contextWindow);
    }

    // 2. Bare modelId lookup (legacy/fallback precedence)
    const existingBare = params.cache.get(normalizedModelId);
    // For the global bare-id cache, prefer the largest window to avoid proxy poisoning (V4.2)
    if (existingBare === undefined || contextWindow > existingBare) {
      params.cache.set(normalizedModelId, contextWindow);
    }
  }
}

export function applyConfiguredContextWindows(params: {
  cache: Map<string, number>;
  modelsConfig: ModelsConfig | undefined;
}) {
  const providers = params.modelsConfig?.providers;
  if (!providers || typeof providers !== "object") {
    return;
  }
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!Array.isArray(provider?.models)) {
      continue;
    }
    for (const model of provider.models) {
      const modelId = typeof model?.id === "string" ? model.id : undefined;
      const contextWindow =
        typeof model?.contextWindow === "number" ? model.contextWindow : undefined;
      if (!modelId || !contextWindow || contextWindow <= 0) {
        continue;
      }

      const normalizedProvider = providerId.toLowerCase().trim();
      const normalizedModelId = normalizeModelId(modelId);

      // Set scoped key (Config overrides discovery)
      params.cache.set(`${normalizedProvider}::${normalizedModelId}`, contextWindow);

      // Set bare key (Largest wins globally to avoid proxy poisoning)
      const existingBare = params.cache.get(normalizedModelId);
      if (existingBare === undefined || contextWindow > existingBare) {
        params.cache.set(normalizedModelId, contextWindow);
      }
    }
  }
}

const MODEL_CACHE = new Map<string, number>();
let loadPromise: Promise<void> | null = null;
let configuredConfig: OpenClawConfig | undefined;
let configLoadFailures = 0;
let nextConfigLoadAttemptAtMs = 0;

function getCommandPathFromArgv(argv: string[]): string[] {
  const args = argv.slice(2);
  const tokens: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || arg === FLAG_TERMINATOR) {
      break;
    }
    const consumed = consumeRootOptionToken(args, i);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    tokens.push(arg);
    if (tokens.length >= 2) {
      break;
    }
  }
  return tokens;
}

function shouldSkipEagerContextWindowWarmup(argv: string[] = process.argv): boolean {
  const [primary, secondary] = getCommandPathFromArgv(argv);
  return primary === "config" && secondary === "validate";
}

function primeConfiguredContextWindows(): OpenClawConfig | undefined {
  if (configuredConfig) {
    return configuredConfig;
  }
  if (Date.now() < nextConfigLoadAttemptAtMs) {
    return undefined;
  }
  try {
    const cfg = loadConfig();
    applyConfiguredContextWindows({
      cache: MODEL_CACHE,
      modelsConfig: cfg.models as ModelsConfig | undefined,
    });
    configuredConfig = cfg;
    configLoadFailures = 0;
    nextConfigLoadAttemptAtMs = 0;
    return cfg;
  } catch {
    configLoadFailures += 1;
    const backoffMs = computeBackoff(CONFIG_LOAD_RETRY_POLICY, configLoadFailures);
    nextConfigLoadAttemptAtMs = Date.now() + backoffMs;
    // If config can't be loaded, leave cache empty and retry after backoff.
    return undefined;
  }
}

function ensureContextWindowCacheLoaded(): Promise<void> {
  if (loadPromise) {
    return loadPromise;
  }

  const cfg = primeConfiguredContextWindows();
  if (!cfg) {
    return Promise.resolve();
  }

  loadPromise = (async () => {
    try {
      await ensureOpenClawModelsJson(cfg);
    } catch {
      // Continue with best-effort discovery/overrides.
    }

    try {
      const { discoverAuthStorage, discoverModels } = await import("./pi-model-discovery.js");
      const agentDir = resolveOpenClawAgentDir();
      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir) as unknown as ModelRegistryLike;
      const models =
        typeof modelRegistry.getAvailable === "function"
          ? modelRegistry.getAvailable()
          : modelRegistry.getAll();
      applyDiscoveredContextWindows({
        cache: MODEL_CACHE,
        models,
      });
    } catch {
      // If model discovery fails, continue with config overrides only.
    }

    applyConfiguredContextWindows({
      cache: MODEL_CACHE,
      modelsConfig: cfg.models as ModelsConfig | undefined,
    });
  })().catch(() => {
    // Keep lookup best-effort.
  });
  return loadPromise;
}

export function lookupContextTokens(modelId?: string, provider?: string): number | undefined {
  if (!modelId) {
    return undefined;
  }
  // Best-effort: kick off loading, but don't block.
  void ensureContextWindowCacheLoaded();

  const normalizedModelId = normalizeModelId(modelId);

  if (provider) {
    const scopedKey = `${provider.toLowerCase().trim()}::${normalizedModelId}`;
    const scopedLimit = MODEL_CACHE.get(scopedKey);
    if (scopedLimit !== undefined) {
      return scopedLimit;
    }
  }

  // Fallback to legacy behavior where we check for a bare modelId match.
  // This supports cases where the provider is not yet known or for generic aliases.
  return MODEL_CACHE.get(normalizedModelId);
}

if (!shouldSkipEagerContextWindowWarmup()) {
  // Keep prior behavior where model limits begin loading during startup.
  // This avoids a cold-start miss on the first context token lookup.
  void ensureContextWindowCacheLoaded();
}

function resolveConfiguredModelParams(
  cfg: OpenClawConfig | undefined,
  provider: string,
  model: string,
): Record<string, unknown> | undefined {
  const models = cfg?.agents?.defaults?.models;
  if (!models) {
    return undefined;
  }
  const key = `${provider}/${model}`.trim().toLowerCase();
  for (const [rawKey, entry] of Object.entries(models)) {
    if (rawKey.trim().toLowerCase() === key) {
      const params = (entry as AgentModelEntry | undefined)?.params;
      return params && typeof params === "object" ? params : undefined;
    }
  }
  return undefined;
}

function resolveProviderModelRef(params: {
  provider?: string;
  model?: string;
}): { provider: string; model: string } | undefined {
  const modelRaw = params.model?.trim();
  if (!modelRaw) {
    return undefined;
  }
  const providerRaw = params.provider?.trim();
  if (providerRaw) {
    return { provider: providerRaw.toLowerCase(), model: normalizeModelId(modelRaw) };
  }
  const slash = modelRaw.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const provider = modelRaw.slice(0, slash).trim().toLowerCase();
  const model = modelRaw.slice(slash + 1).trim();
  if (!provider || !model) {
    return undefined;
  }
  return { provider, model: normalizeModelId(model) };
}

function isAnthropic1MModel(provider: string, model: string): boolean {
  if (provider !== "anthropic") {
    return false;
  }
  const normalized = model.trim().toLowerCase();
  const modelId = normalized.includes("/")
    ? (normalized.split("/").at(-1) ?? normalized)
    : normalized;
  return ANTHROPIC_1M_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

export function resolveContextTokensForModel(params: {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  contextTokensOverride?: number;
  fallbackContextTokens?: number;
}): number | undefined {
  if (typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0) {
    return params.contextTokensOverride;
  }

  const ref = resolveProviderModelRef({
    provider: params.provider,
    model: params.model,
  });
  if (ref) {
    const modelParams = resolveConfiguredModelParams(params.cfg, ref.provider, ref.model);
    if (modelParams?.context1m === true && isAnthropic1MModel(ref.provider, ref.model)) {
      return ANTHROPIC_CONTEXT_1M_TOKENS;
    }
  }

  return lookupContextTokens(params.model, params.provider) ?? params.fallbackContextTokens;
}
