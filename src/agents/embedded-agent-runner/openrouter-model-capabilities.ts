// Dynamic OpenRouter models use a process cache backed by shared SQLite.
// Rows have no TTL: await first-use or missing-model refresh; synchronous
// lookups consume cached capabilities while a missing-model refresh runs.

import { normalizeOpenRouterModelReasoning } from "@openclaw/model-catalog-core/model-catalog-normalize";
import { normalizeOpenRouterModelPricing } from "@openclaw/model-catalog-core/model-catalog-pricing";
import type { ModelCatalogModel } from "@openclaw/model-catalog-core/model-catalog-types";
import { formatErrorMessage } from "../../infra/errors.js";
import { cancelUnreadResponseBody } from "../../infra/http-body.js";
import { resolveProxyFetchFromEnv } from "../../infra/net/proxy-fetch.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  createCorePluginStateSyncKeyedStore,
  prepareCorePluginStateReplacement,
} from "../../plugin-state/plugin-state-store.js";
import type { PluginStateEntry } from "../../plugin-state/plugin-state-store.types.js";
import { runOutsideAsyncWorkScope } from "../../shared/async-work-scope.js";
import { registerPreparedModelRuntimeClose } from "../prepared-model-runtime.lifecycle.js";
import { readProviderJsonArrayFieldResponse } from "../provider-http-errors.js";

const log = createSubsystemLogger("openrouter-model-capabilities");

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 10_000;
const SQLITE_CACHE_OWNER_ID = "core:openrouter-model-capabilities";
// v3 did not retain effort-selection or mandatory-reasoning capabilities.
const SQLITE_CACHE_NAMESPACE = "models.v4";
const SQLITE_CACHE_MAX_ENTRIES = 10_000;
const SQLITE_CACHE_OPTIONS = {
  ownerId: SQLITE_CACHE_OWNER_ID,
  namespace: SQLITE_CACHE_NAMESPACE,
  maxEntries: SQLITE_CACHE_MAX_ENTRIES,
} as const;

interface OpenRouterApiModel {
  id: string;
  name?: string;
  modality?: string;
  architecture?: {
    modality?: string;
  };
  supported_parameters?: string[];
  reasoning?: unknown;
  context_length?: number;
  max_completion_tokens?: number;
  max_output_tokens?: number;
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
  pricing?: unknown;
}

interface OpenRouterModelCapabilities extends Pick<
  ModelCatalogModel,
  "compat" | "thinkingLevelMap"
> {
  name: string;
  input: Array<"text" | "image">;
  reasoning: boolean;
  supportsTools?: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: NonNullable<ReturnType<typeof normalizeOpenRouterModelPricing>>;
}

function isValidCapabilities(value: unknown): value is OpenRouterModelCapabilities {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    Array.isArray(record.input) &&
    typeof record.reasoning === "boolean" &&
    typeof record.contextWindow === "number" &&
    typeof record.maxTokens === "number"
  );
}

function openSqliteCacheStore() {
  return createCorePluginStateSyncKeyedStore<OpenRouterModelCapabilities>(SQLITE_CACHE_OPTIONS);
}

type PreparedCacheStore = ReturnType<
  typeof prepareCorePluginStateReplacement<OpenRouterModelCapabilities>
>;

function prepareSqliteCacheStore(): PreparedCacheStore | null {
  try {
    return prepareCorePluginStateReplacement<OpenRouterModelCapabilities>(SQLITE_CACHE_OPTIONS);
  } catch (err: unknown) {
    log.debug(`Failed to open OpenRouter SQLite cache: ${formatErrorMessage(err)}`);
    return null;
  }
}

async function writeSqliteCache(
  store: PreparedCacheStore | null,
  map: Map<string, OpenRouterModelCapabilities>,
): Promise<void> {
  try {
    await store?.replace(map);
  } catch (err: unknown) {
    const message = formatErrorMessage(err);
    log.debug(`Failed to write OpenRouter SQLite cache: ${message}`);
  }
}

function readSqliteCache(): Map<string, OpenRouterModelCapabilities> | undefined {
  try {
    return parseSqliteCache(openSqliteCacheStore().entries());
  } catch (err: unknown) {
    const message = formatErrorMessage(err);
    log.debug(`Failed to read OpenRouter SQLite cache: ${message}`);
    return undefined;
  }
}

function parseSqliteCache(entries: PluginStateEntry<OpenRouterModelCapabilities>[]) {
  const map = new Map<string, OpenRouterModelCapabilities>();
  for (const { key, value } of entries) {
    if (isValidCapabilities(value)) {
      map.set(key, value);
    }
  }
  return map.size > 0 ? map : undefined;
}

function trackCatalogWork<T>(run: () => Promise<T>): Promise<T> {
  // Model runtime close joins accepted catalog persistence before database retirement.
  // Scheduler cancellation must not abort that persistence while it is being joined.
  const unregister = registerPreparedModelRuntimeClose(async () => {
    await work;
  });
  const work = runOutsideAsyncWorkScope(run).finally(unregister);
  return work;
}

let cache: Map<string, OpenRouterModelCapabilities> | undefined;
let fetchInFlight: Promise<void> | undefined;
let cacheReadInFlight: Promise<PreparedCacheStore | null> | undefined;
const skipNextMissRefresh = new Set<string>();

function parseModel(model: OpenRouterApiModel): OpenRouterModelCapabilities {
  const input: Array<"text" | "image"> = ["text"];
  const modality = model.architecture?.modality ?? model.modality ?? "";
  const inputModalities = modality.split("->")[0] ?? "";
  if (inputModalities.includes("image")) {
    input.push("image");
  }
  const supportedParameters = Array.isArray(model.supported_parameters)
    ? model.supported_parameters
    : undefined;

  return {
    name: model.name || model.id,
    input,
    reasoning: supportedParameters?.includes("reasoning") ?? false,
    ...normalizeOpenRouterModelReasoning(model.reasoning),
    ...(supportedParameters ? { supportsTools: supportedParameters.includes("tools") } : {}),
    contextWindow: model.top_provider?.context_length ?? model.context_length ?? 128_000,
    maxTokens:
      model.top_provider?.max_completion_tokens ??
      model.max_completion_tokens ??
      model.max_output_tokens ??
      8192,
    cost: normalizeOpenRouterModelPricing(model.pricing) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  };
}

async function doFetch(store: PreparedCacheStore | null): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response | undefined;
  try {
    const fetchFn = resolveProxyFetchFromEnv() ?? globalThis.fetch;

    response = await fetchFn(OPENROUTER_MODELS_URL, {
      signal: controller.signal,
    });

    if (!response.ok) {
      log.warn(`OpenRouter models API returned ${response.status}`);
      return;
    }

    const models = await readProviderJsonArrayFieldResponse(
      response,
      "OpenRouter models response",
      "data",
    );
    const map = new Map<string, OpenRouterModelCapabilities>();

    for (const value of models) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const model = value as OpenRouterApiModel;
      if (typeof model.id !== "string" || !model.id) {
        continue;
      }
      map.set(model.id, parseModel(model));
    }

    cache = map;
    await writeSqliteCache(store, map);
    log.debug(`Cached ${map.size} OpenRouter models from API`);
  } catch (err: unknown) {
    const message = formatErrorMessage(err);
    log.warn(`Failed to fetch OpenRouter models: ${message}`);
  } finally {
    clearTimeout(timeout);
    await cancelUnreadResponseBody(response);
  }
}

function triggerFetch(store?: PreparedCacheStore | null): void {
  if (fetchInFlight) {
    return;
  }
  const prepared = store === undefined ? prepareSqliteCacheStore() : store;
  fetchInFlight = trackCatalogWork(() => doFetch(prepared)).finally(() => {
    fetchInFlight = undefined;
  });
}

function ensureOpenRouterModelCache(): void {
  if (cache) {
    return;
  }

  const stored = readSqliteCache();
  if (stored) {
    cache = stored;
    log.debug(`Loaded ${stored.size} OpenRouter models from SQLite cache`);
    return;
  }

  triggerFetch();
}

/**
 * Ensure capabilities for a specific model are available before first use.
 *
 * Known cached entries return immediately. Unknown entries wait for at most
 * one catalog fetch, then leave sync resolution to read from the populated
 * cache on the same request.
 *
 * @deprecated OpenRouter provider-owned catalog helper; do not use from third-party plugins.
 */
export async function loadOpenRouterModelCapabilities(modelId: string): Promise<void> {
  let store: PreparedCacheStore | null | undefined;
  if (!cache) {
    cacheReadInFlight ??= trackCatalogWork(async () => {
      const prepared = prepareSqliteCacheStore();
      try {
        const stored = prepared ? parseSqliteCache(await prepared.entries()) : undefined;
        if (stored && !cache) {
          cache = stored;
          log.debug(`Loaded ${stored.size} OpenRouter models from SQLite cache`);
        }
      } catch (err: unknown) {
        log.debug(`Failed to read OpenRouter SQLite cache: ${formatErrorMessage(err)}`);
      }
      return prepared;
    }).finally(() => {
      cacheReadInFlight = undefined;
    });
    store = await cacheReadInFlight;
  }
  if (cache?.has(modelId)) {
    return;
  }
  triggerFetch(store);
  await fetchInFlight;
  if (!cache?.has(modelId)) {
    skipNextMissRefresh.add(modelId);
  }
}

/**
 * Synchronously look up model capabilities from the cache.
 *
 * If a model is not found but the cache exists, a background refresh is
 * triggered in case it's a newly added model not yet in the cache.
 * The cold synchronous read is retained for the v2026.9.8 provider-stream SDK contract.
 *
 * @deprecated OpenRouter provider-owned catalog helper; do not use from third-party plugins.
 */
export function getOpenRouterModelCapabilities(
  modelId: string,
): OpenRouterModelCapabilities | undefined {
  // A failed awaited load, such as an oversized catalog body, already attempted
  // a refresh. Do not let the follow-up sync lookup immediately retry it.
  const skipMissRefresh = skipNextMissRefresh.delete(modelId);
  if (!skipMissRefresh) {
    ensureOpenRouterModelCache();
  }
  const result = cache?.get(modelId);

  if (!result && !skipMissRefresh && cache) {
    triggerFetch();
  }

  return result;
}

/**
 * Read capabilities already loaded in process memory.
 *
 * Synchronous policy reads follow catalog refreshes without reading SQLite or
 * starting a fetch; runtime model resolution loads the catalog first.
 */
export function getLoadedOpenRouterModelCapabilities(
  modelId: string,
): OpenRouterModelCapabilities | undefined {
  skipNextMissRefresh.delete(modelId);
  return cache?.get(modelId);
}
