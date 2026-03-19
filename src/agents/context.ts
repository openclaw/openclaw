// Lazy-load pi-coding-agent model metadata so we can infer context windows when
// the agent reports a model id. This includes custom models.json entries.

import path from "node:path";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { computeBackoff, type BackoffPolicy } from "../infra/backoff.js";
import { consumeRootOptionToken, FLAG_TERMINATOR } from "../infra/cli-root-options.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { normalizeProviderId } from "./model-selection.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

type ModelEntry = { id: string; contextWindow?: number };
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
    if (!model?.id) {
      continue;
    }
    const contextWindow =
      typeof model.contextWindow === "number" ? Math.trunc(model.contextWindow) : undefined;
    if (!contextWindow || contextWindow <= 0) {
      continue;
    }
    const existing = params.cache.get(model.id);
    // When the same bare model id appears under multiple providers with different
    // limits, keep the smaller window. This cache feeds both display paths and
    // runtime paths (flush thresholds, session context-token persistence), so
    // overestimating the limit could delay compaction and cause context overflow.
    // Callers that know the active provider should use resolveContextTokensForModel,
    // which tries the provider-qualified key first and falls back here.
    if (existing === undefined || contextWindow < existing) {
      params.cache.set(model.id, contextWindow);
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
  for (const provider of Object.values(providers)) {
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
      params.cache.set(modelId, contextWindow);
    }
  }
}

const MODEL_CACHE = new Map<string, number>();
let loadPromise: Promise<void> | null = null;
let configuredConfig: OpenClawConfig | undefined;
let configLoadFailures = 0;
let nextConfigLoadAttemptAtMs = 0;

function isLikelyOpenClawCliProcess(argv: string[] = process.argv): boolean {
  const entryBasename = path
    .basename(argv[1] ?? "")
    .trim()
    .toLowerCase();
  return (
    entryBasename === "openclaw" ||
    entryBasename === "openclaw.mjs" ||
    entryBasename === "entry.js" ||
    entryBasename === "entry.mjs"
  );
}

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

const SKIP_EAGER_WARMUP_PRIMARY_COMMANDS = new Set([
  "backup",
  "completion",
  "config",
  "directory",
  "doctor",
  "gateway",
  "health",
  "hooks",
  "logs",
  "plugins",
  "secrets",
  "status",
  "update",
  "webhooks",
]);

function shouldEagerWarmContextWindowCache(argv: string[] = process.argv): boolean {
  // Keep this gate tied to the real OpenClaw CLI entrypoints.
  //
  // This module can also land inside shared dist chunks that are imported from
  // plugin-sdk/library surfaces during smoke tests and plugin loading. If we do
  // eager warmup for those generic Node script imports, merely importing the
  // built plugin-sdk can call ensureOpenClawModelsJson(), which cascades into
  // plugin discovery and breaks dist/source singleton assumptions.
  if (!isLikelyOpenClawCliProcess(argv)) {
    return false;
  }
  const [primary] = getCommandPathFromArgv(argv);
  return Boolean(primary) && !SKIP_EAGER_WARMUP_PRIMARY_COMMANDS.has(primary);
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
      const { discoverAuthStorage, discoverModels } =
        await import("./pi-model-discovery-runtime.js");
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

export function lookupContextTokens(modelId?: string): number | undefined {
  if (!modelId) {
    return undefined;
  }
  // Best-effort: kick off loading on demand, but don't block lookups.
  void ensureContextWindowCacheLoaded();
  return MODEL_CACHE.get(modelId);
}

if (shouldEagerWarmContextWindowCache()) {
  // Keep startup warmth for the real CLI, but avoid import-time side effects
  // when this module is pulled in through library/plugin-sdk surfaces.
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
    // Keep the exact (lowercased) provider key; callers that need the canonical
    // alias (e.g. cache key construction) apply normalizeProviderId explicitly.
    return { provider: providerRaw.toLowerCase(), model: modelRaw };
  }
  const slash = modelRaw.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const provider = normalizeProviderId(modelRaw.slice(0, slash));
  const model = modelRaw.slice(slash + 1).trim();
  if (!provider || !model) {
    return undefined;
  }
  return { provider, model };
}

// Look up an explicit contextWindow override for a specific provider+model
// directly from config, without going through the shared discovery cache.
// This avoids the cache keyspace collision where "provider/model" synthetic
// keys overlap with raw slash-containing model IDs (e.g. OpenRouter's
// "google/gemini-2.5-pro" stored as a raw catalog entry).
function resolveConfiguredProviderContextWindow(
  cfg: OpenClawConfig | undefined,
  provider: string,
  model: string,
): number | undefined {
  const providers = (cfg?.models as ModelsConfig | undefined)?.providers;
  if (!providers) {
    return undefined;
  }

  // Mirror the lookup order in pi-embedded-runner/model.ts: exact key first,
  // then normalized fallback. This prevents alias collisions (e.g. when both
  // "qwen" and "qwen-portal" exist as config keys) from picking the wrong
  // contextWindow based on Object.entries iteration order.
  function findContextWindow(matchProviderId: (id: string) => boolean): number | undefined {
    for (const [providerId, providerConfig] of Object.entries(providers!)) {
      if (!matchProviderId(providerId)) {
        continue;
      }
      if (!Array.isArray(providerConfig?.models)) {
        continue;
      }
      for (const m of providerConfig.models) {
        if (
          typeof m?.id === "string" &&
          m.id === model &&
          typeof m?.contextWindow === "number" &&
          m.contextWindow > 0
        ) {
          return m.contextWindow;
        }
      }
    }
    return undefined;
  }

  // 1. Exact match (case-insensitive, no alias expansion).
  const exactResult = findContextWindow((id) => id.trim().toLowerCase() === provider.toLowerCase());
  if (exactResult !== undefined) {
    return exactResult;
  }

  // 2. Normalized fallback: covers alias keys such as "qwen" → "qwen-portal".
  const normalizedProvider = normalizeProviderId(provider);
  return findContextWindow((id) => normalizeProviderId(id) === normalizedProvider);
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
    // Only do the config direct scan when the caller explicitly passed a
    // provider. When provider is inferred from a slash in the model string
    // (e.g. "google/gemini-2.5-pro" → ref.provider = "google"), the model ID
    // may belong to a DIFFERENT provider (e.g. an OpenRouter session). Scanning
    // cfg.models.providers.google in that case would return Google's configured
    // window and misreport context limits for the OpenRouter session.
    // See status.ts log-usage fallback which calls with only { model } set.
    if (params.provider) {
      const configuredWindow = resolveConfiguredProviderContextWindow(
        params.cfg,
        ref.provider,
        ref.model,
      );
      if (configuredWindow !== undefined) {
        return configuredWindow;
      }
    }
  }

  // When provider is explicitly given and the model ID is bare (no slash),
  // try the provider-qualified cache key BEFORE the bare key.  Discovery
  // entries are stored under qualified IDs (e.g. "google-gemini-cli/
  // gemini-3.1-pro-preview → 1M"), while the bare key may hold a cross-
  // provider minimum (128k).  Returning the qualified entry gives the correct
  // provider-specific window for /status and session context-token persistence.
  //
  // Guard: only when params.provider is explicit (not inferred from a slash in
  // the model string). For model-only callers (e.g. status.ts log-usage
  // fallback with model="google/gemini-2.5-pro"), the inferred provider would
  // construct "google/gemini-2.5-pro" as the qualified key which accidentally
  // matches OpenRouter's raw discovery entry — the bare lookup is correct there.
  if (params.provider && ref && !ref.model.includes("/")) {
    const qualifiedResult = lookupContextTokens(
      `${normalizeProviderId(ref.provider)}/${ref.model}`,
    );
    if (qualifiedResult !== undefined) {
      return qualifiedResult;
    }
  }

  // Bare key fallback.  For model-only calls with slash-containing IDs
  // (e.g. "google/gemini-2.5-pro") this IS the raw discovery cache key.
  const bareResult = lookupContextTokens(params.model);
  if (bareResult !== undefined) {
    return bareResult;
  }

  // When provider is implicit, try qualified as a last resort so inferred
  // provider/model pairs (e.g. model="google-gemini-cli/gemini-3.1-pro")
  // still find discovery entries stored under that qualified ID.
  if (!params.provider && ref && !ref.model.includes("/")) {
    const qualifiedResult = lookupContextTokens(
      `${normalizeProviderId(ref.provider)}/${ref.model}`,
    );
    if (qualifiedResult !== undefined) {
      return qualifiedResult;
    }
  }

  return params.fallbackContextTokens;
}
