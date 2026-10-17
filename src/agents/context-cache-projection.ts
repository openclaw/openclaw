import { setImmediate as yieldToGateway } from "node:timers/promises";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ContextWindowCacheState, providerContextTokenCacheKey } from "./context-cache.js";
import { type ModelsConfig, resolveAnthropicFixedContextWindow } from "./context-resolution.js";

const CONTEXT_PROJECTION_BATCH_SIZE = 512;

type ContextWindowModelEntry = {
  id: string;
  provider?: string;
  contextWindow?: number;
  contextTokens?: number;
};

export type ContextWindowCatalog = {
  entries: ContextWindowModelEntry[];
  staticEntries?: ContextWindowModelEntry[];
};

type ConfiguredProvider = NonNullable<ModelsConfig["providers"]>[string];
type ConfiguredModel = NonNullable<NonNullable<ConfiguredProvider>["models"]>[number];

function cacheMinimum(cache: Map<string, number>, key: string, contextTokens: number): void {
  const existing = cache.get(key);
  if (existing === undefined || contextTokens < existing) {
    cache.set(key, contextTokens);
  }
}

function contextModelKeys(modelId: string, provider?: string): string[] {
  const keys = [modelId];
  if (provider === undefined) {
    return keys;
  }
  keys.push(providerContextTokenCacheKey(provider, modelId));
  const slash = modelId.indexOf("/");
  const prefixedProvider = slash > 0 ? normalizeProviderId(modelId.slice(0, slash)) : "";
  const bareModelId = slash > 0 ? modelId.slice(slash + 1).trim() : "";
  if (provider && prefixedProvider === provider && bareModelId) {
    keys.push(providerContextTokenCacheKey(provider, bareModelId));
  }
  return keys;
}

function applyDiscoveredContextWindow(
  cache: Map<string, number>,
  model: ContextWindowModelEntry,
): void {
  if (!model.id) {
    return;
  }
  const discoveredContextTokens =
    typeof model.contextTokens === "number"
      ? Math.trunc(model.contextTokens)
      : typeof model.contextWindow === "number"
        ? Math.trunc(model.contextWindow)
        : undefined;
  const contextTokens =
    resolveDiscoveredAnthropicFixedContextWindow(model) ?? discoveredContextTokens;
  if (!contextTokens || contextTokens <= 0) {
    return;
  }

  const provider = model.provider ? normalizeProviderId(model.provider) : "";
  for (const key of contextModelKeys(model.id, provider || undefined)) {
    cacheMinimum(cache, key, contextTokens);
  }
}

function* configuredModels(modelsConfig: ModelsConfig | undefined) {
  for (const [providerId, provider] of Object.entries(modelsConfig?.providers ?? {})) {
    for (const model of provider?.models ?? []) {
      yield { providerId, model };
    }
  }
}

export function applyConfiguredContextWindows(params: {
  cache: Map<string, number>;
  windowCache: Map<string, number>;
  modelsConfig: ModelsConfig | undefined;
}): void {
  for (const model of configuredModels(params.modelsConfig)) {
    applyConfiguredContextWindow({ ...params, ...model });
  }
}

function applyConfiguredContextWindow(params: {
  cache: Map<string, number>;
  windowCache: Map<string, number>;
  providerId: string;
  model: ConfiguredModel;
}): void {
  const { id: modelId, contextTokens, contextWindow } = params.model;
  const configuredValue =
    contextTokens && contextTokens > 0
      ? { cache: params.cache, value: contextTokens }
      : contextWindow && contextWindow > 0
        ? { cache: params.windowCache, value: contextWindow }
        : undefined;
  if (!modelId || !configuredValue) {
    return;
  }
  for (const key of contextModelKeys(modelId, normalizeProviderId(params.providerId))) {
    configuredValue.cache.set(key, configuredValue.value);
  }
}

function resolveDiscoveredAnthropicFixedContextWindow(
  model: ContextWindowModelEntry,
): number | undefined {
  const provider = model.provider ? normalizeProviderId(model.provider) : undefined;
  if (provider) {
    return resolveAnthropicFixedContextWindow(provider, model.id);
  }
  const normalized = normalizeLowercaseStringOrEmpty(model.id);
  const slash = normalized.indexOf("/");
  if (slash < 0) {
    return undefined;
  }
  const inferredProvider = normalizeProviderId(normalized.slice(0, slash));
  const inferredModel = normalized.slice(slash + 1);
  return inferredProvider === "claude-cli"
    ? resolveAnthropicFixedContextWindow(inferredProvider, inferredModel)
    : undefined;
}

async function projectModels(params: {
  cache: Map<string, number>;
  modelCatalog: ContextWindowCatalog;
  processed: number;
}): Promise<void> {
  let processed = params.processed;
  for (const models of [params.modelCatalog.entries, params.modelCatalog.staticEntries ?? []]) {
    for (const model of models) {
      applyDiscoveredContextWindow(params.cache, model);
      processed += 1;
      if (processed % CONTEXT_PROJECTION_BATCH_SIZE === 0) {
        await yieldToGateway();
      }
    }
  }
}

export async function prepareContextWindowCaches(params: {
  config: OpenClawConfig;
  modelCatalog: ContextWindowCatalog;
}): Promise<ContextWindowCacheState> {
  const caches: ContextWindowCacheState = {
    configuredTokenCache: new Map(),
    discoveredTokenCache: new Map(),
    contextWindowCache: new Map(),
  };
  let processed = 0;
  for (const model of configuredModels(params.config.models)) {
    applyConfiguredContextWindow({
      cache: caches.configuredTokenCache,
      windowCache: caches.contextWindowCache,
      ...model,
    });
    processed += 1;
    if (processed % CONTEXT_PROJECTION_BATCH_SIZE === 0) {
      await yieldToGateway();
    }
  }
  await projectModels({
    cache: caches.discoveredTokenCache,
    modelCatalog: params.modelCatalog,
    processed,
  });
  return caches;
}

export async function prepareDiscoveredContextTokenCache(params: {
  modelCatalog: ContextWindowCatalog;
}): Promise<Map<string, number>> {
  const cache = new Map<string, number>();
  await projectModels({
    cache,
    modelCatalog: params.modelCatalog,
    processed: 0,
  });
  return cache;
}
