/**
 * Runtime Novita AI model capability detection.
 *
 * When a Novita model is not in the built-in static list, we look up its
 * actual capabilities from a cached copy of the Novita AI model catalog.
 *
 * Cache layers (checked in order):
 * 1. In-memory Map (instant, cleared on process restart)
 * 2. On-disk JSON file (<stateDir>/cache/novita-models.json)
 * 3. Novita AI API fetch (populates both layers)
 *
 * Model capabilities are assumed stable — the cache has no TTL expiry.
 * A background refresh is triggered only when a model is not found in
 * the cache (i.e. a newly added model on Novita AI).
 *
 * Unlike OpenRouter, the Novita API requires authentication (Bearer token),
 * so fetch functions accept an apiKey parameter.
 *
 * Sync callers can read whatever is already cached. Async callers can await a
 * one-time fetch so the first unknown-model lookup resolves with real
 * capabilities instead of the text-only fallback.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { resolveProxyFetchFromEnv } from "../../infra/net/proxy-fetch.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("novita-model-capabilities");

const NOVITA_MODELS_URL = "https://api.novita.ai/v3/openai/models";
const FETCH_TIMEOUT_MS = 10_000;
const DISK_CACHE_FILENAME = "novita-models.json";

// ---------------------------------------------------------------------------
// Types — Novita AI /models response
// ---------------------------------------------------------------------------

interface NovitaApiModel {
  id: string;
  display_name?: string;
  input_token_price_per_m: number;
  output_token_price_per_m: number;
  context_size: number;
  max_output_tokens: number;
  features?: string[];
  input_modalities?: string[];
  model_type?: string;
  status?: number;
}

export interface NovitaModelCapabilities {
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

interface DiskCachePayload {
  models: Record<string, NovitaModelCapabilities>;
}

// ---------------------------------------------------------------------------
// Price conversion
// ---------------------------------------------------------------------------

/**
 * Novita AI API returns prices in 1/10000 USD per million tokens.
 * OpenClaw expects USD per million tokens.
 *
 * Example: API returns 2700 → $0.27/M tokens.
 */
const PRICE_DIVISOR = 10_000;

function convertPrice(apiPrice: number): number {
  return apiPrice / PRICE_DIVISOR;
}

// ---------------------------------------------------------------------------
// Model parsing
// ---------------------------------------------------------------------------

function parseModel(model: NovitaApiModel): NovitaModelCapabilities {
  const input: Array<"text" | "image"> = ["text"];
  if (model.input_modalities?.includes("image")) {
    input.push("image");
  }

  const inputCost = convertPrice(model.input_token_price_per_m);
  const outputCost = convertPrice(model.output_token_price_per_m);

  return {
    name: model.display_name || model.id,
    input,
    reasoning: model.features?.includes("reasoning") ?? false,
    contextWindow: model.context_size || 128_000,
    maxTokens: model.max_output_tokens || 8192,
    cost: {
      input: inputCost,
      output: outputCost,
      // Novita AI does not expose cache pricing in the /models API.
      // Cache read ratios vary by vendor (14%-50%), so we leave these
      // at 0 rather than guessing — consistent with other aggregator providers.
      cacheRead: 0,
      cacheWrite: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

function resolveDiskCacheDir(): string {
  return join(resolveStateDir(), "cache");
}

function resolveDiskCachePath(): string {
  return join(resolveDiskCacheDir(), DISK_CACHE_FILENAME);
}

function writeDiskCache(map: Map<string, NovitaModelCapabilities>): void {
  try {
    const cacheDir = resolveDiskCacheDir();
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    const payload: DiskCachePayload = {
      models: Object.fromEntries(map),
    };
    writeFileSync(resolveDiskCachePath(), JSON.stringify(payload), "utf-8");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug(`Failed to write Novita disk cache: ${message}`);
  }
}

function isValidCapabilities(value: unknown): value is NovitaModelCapabilities {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const cost = record.cost as Record<string, unknown> | undefined;
  return (
    typeof record.name === "string" &&
    Array.isArray(record.input) &&
    typeof record.reasoning === "boolean" &&
    typeof record.contextWindow === "number" &&
    typeof record.maxTokens === "number" &&
    typeof cost === "object" &&
    cost !== null &&
    typeof cost.input === "number" &&
    typeof cost.output === "number"
  );
}

function readDiskCache(): Map<string, NovitaModelCapabilities> | undefined {
  try {
    const cachePath = resolveDiskCachePath();
    if (!existsSync(cachePath)) {
      return undefined;
    }
    const raw = readFileSync(cachePath, "utf-8");
    const payload = JSON.parse(raw) as unknown;
    if (!payload || typeof payload !== "object") {
      return undefined;
    }
    const models = (payload as DiskCachePayload).models;
    if (!models || typeof models !== "object") {
      return undefined;
    }
    const map = new Map<string, NovitaModelCapabilities>();
    for (const [id, caps] of Object.entries(models)) {
      if (isValidCapabilities(caps)) {
        map.set(id, caps);
      }
    }
    return map.size > 0 ? map : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// In-memory cache state
// ---------------------------------------------------------------------------

let cache: Map<string, NovitaModelCapabilities> | undefined;
let fetchInFlight: Promise<void> | undefined;
const skipNextMissRefresh = new Set<string>();

// ---------------------------------------------------------------------------
// API fetch
// ---------------------------------------------------------------------------

async function doFetch(apiKey: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const fetchFn = resolveProxyFetchFromEnv() ?? globalThis.fetch;

    const response = await fetchFn(NOVITA_MODELS_URL, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      log.warn(`Novita AI models API returned ${response.status}`);
      return;
    }

    const data = (await response.json()) as { data?: NovitaApiModel[] };
    const models = data.data ?? [];
    const map = new Map<string, NovitaModelCapabilities>();

    for (const model of models) {
      if (!model.id || model.status === 0) {
        continue;
      }
      map.set(model.id, parseModel(model));
    }

    cache = map;
    writeDiskCache(map);
    log.debug(`Cached ${map.size} Novita AI models from API`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to fetch Novita AI models: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** Stored API key from the most recent fetch trigger. */
let lastApiKey: string | undefined;

function triggerFetch(apiKey: string): void {
  if (fetchInFlight) {
    return;
  }
  lastApiKey = apiKey;
  fetchInFlight = doFetch(apiKey).finally(() => {
    fetchInFlight = undefined;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the cache is populated. Checks in-memory first, then disk, then
 * triggers a background API fetch as a last resort.
 * Does not block — returns immediately.
 */
export function ensureNovitaModelCache(apiKey: string): void {
  if (cache) {
    return;
  }

  // Try loading from disk before hitting the network.
  const disk = readDiskCache();
  if (disk) {
    cache = disk;
    log.debug(`Loaded ${disk.size} Novita AI models from disk cache`);
    return;
  }

  triggerFetch(apiKey);
}

/**
 * Ensure capabilities for a specific model are available before first use.
 *
 * Known cached entries return immediately. Unknown entries wait for at most
 * one catalog fetch, then leave sync resolution to read from the populated
 * cache on the same request.
 */
export async function loadNovitaModelCapabilities(modelId: string, apiKey: string): Promise<void> {
  ensureNovitaModelCache(apiKey);
  if (cache?.has(modelId)) {
    return;
  }
  let fetchPromise = fetchInFlight;
  if (!fetchPromise) {
    triggerFetch(apiKey);
    fetchPromise = fetchInFlight;
  }
  await fetchPromise;
  if (!cache?.has(modelId)) {
    skipNextMissRefresh.add(modelId);
  }
}

/**
 * Synchronously look up model capabilities from the cache.
 *
 * If a model is not found but the cache exists, a background refresh is
 * triggered in case it's a newly added model not yet in the cache.
 */
export function getNovitaModelCapabilities(modelId: string): NovitaModelCapabilities | undefined {
  ensureNovitaModelCache(lastApiKey ?? "");
  const result = cache?.get(modelId);

  // Model not found but cache exists — may be a newly added model.
  // Trigger a refresh so the next call picks it up.
  if (!result && skipNextMissRefresh.delete(modelId)) {
    return undefined;
  }
  if (!result && cache && !fetchInFlight && lastApiKey) {
    triggerFetch(lastApiKey);
  }

  return result;
}

/**
 * Get all cached models as an array suitable for catalog building.
 */
export function getAllCachedNovitaModels(): Map<string, NovitaModelCapabilities> | undefined {
  return cache;
}
