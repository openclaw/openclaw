/**
 * Runtime OpenRouter model capability detection.
 *
 * When an OpenRouter model is not in the built-in static list, we look up its
 * actual capabilities from a cached copy of the OpenRouter model catalog.
 *
 * The cache is populated lazily on first lookup (fire-and-forget) and refreshed
 * periodically.  All public APIs are synchronous — the first lookup for an
 * unknown model may return `undefined` (cache miss), but subsequent calls will
 * hit the populated cache.
 */

import { resolveProxyFetchFromEnv } from "../../infra/net/proxy-fetch.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("openrouter-model-capabilities");

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenRouterApiModel {
  id: string;
  name?: string;
  architecture?: {
    modality?: string;
  };
  supported_parameters?: string[];
  context_length?: number;
  top_provider?: {
    max_completion_tokens?: number;
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
}

export interface OpenRouterModelCapabilities {
  name: string;
  input: Array<"text" | "image">;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

// ---------------------------------------------------------------------------
// Cache state
// ---------------------------------------------------------------------------

let cache: Map<string, OpenRouterModelCapabilities> | undefined;
let cacheTimestamp = 0;
let fetchInFlight: Promise<void> | undefined;

function isCacheValid(): boolean {
  return cache !== undefined && Date.now() - cacheTimestamp < CACHE_TTL_MS;
}

function parseModel(model: OpenRouterApiModel): OpenRouterModelCapabilities {
  const input: Array<"text" | "image"> = ["text"];
  if (model.architecture?.modality?.includes("image")) {
    input.push("image");
  }

  return {
    name: model.name || model.id,
    input,
    reasoning: model.supported_parameters?.includes("reasoning") ?? false,
    contextWindow: model.context_length || 128_000,
    maxTokens: model.top_provider?.max_completion_tokens || 8192,
    cost: {
      input: parseFloat(model.pricing?.prompt || "0") * 1_000_000,
      output: parseFloat(model.pricing?.completion || "0") * 1_000_000,
      cacheRead: parseFloat(model.pricing?.input_cache_read || "0") * 1_000_000,
      cacheWrite: parseFloat(model.pricing?.input_cache_write || "0") * 1_000_000,
    },
  };
}

async function doFetch(): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const fetchFn = resolveProxyFetchFromEnv() ?? globalThis.fetch;

    const response = await fetchFn(OPENROUTER_MODELS_URL, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      log.warn(`OpenRouter models API returned ${response.status}`);
      return;
    }

    const data = (await response.json()) as { data?: OpenRouterApiModel[] };
    const models = data.data ?? [];
    const map = new Map<string, OpenRouterModelCapabilities>();

    for (const model of models) {
      if (!model.id) {
        continue;
      }
      map.set(model.id, parseModel(model));
    }

    cache = map;
    cacheTimestamp = Date.now();
    log.debug(`Cached ${map.size} OpenRouter models from API`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to fetch OpenRouter models: ${message}`);
  }
}

/**
 * Trigger a background fetch if the cache is stale or empty.
 * Does not block — returns immediately.
 */
export function ensureOpenRouterModelCache(): void {
  if (isCacheValid() || fetchInFlight) {
    return;
  }
  fetchInFlight = doFetch().finally(() => {
    fetchInFlight = undefined;
  });
}

/**
 * Synchronously look up model capabilities from the cache.
 *
 * If the cache has not been populated yet, this kicks off a background fetch
 * and returns `undefined` for the current call.  The next call (after the
 * fetch completes) will return the cached data.
 */
export function getOpenRouterModelCapabilities(
  modelId: string,
): OpenRouterModelCapabilities | undefined {
  ensureOpenRouterModelCache();
  return cache?.get(modelId);
}
