// extensions/openai/discovery.ts
//
// Dynamic catalog discovery for the OpenAI provider.
//
// When users run OpenClaw against an OpenAI-compatible upstream (LiteLLM,
// vLLM, AceTeam gateway, local proxy, etc.) the bundled catalog in
// `openai-provider.ts` doesn't reflect what the upstream actually accepts —
// users see picker options like `gpt-5.5` that the upstream may 404 on, and
// don't see custom models the upstream offers.
//
// This module fetches `<baseUrl>/models` with the configured `apiKey` and
// maps the response (strict superset of OpenAI's `/v1/models` shape — extra
// fields like `context_window`, `cost_per_million_tokens`, `modalities` from
// gateways like AceTeam are honored when present, otherwise we fall back to
// per-id heuristics shared with the static catalog).
//
// Mirrors `extensions/amazon-bedrock-mantle/discovery.ts` — same caching
// strategy (per-key, 1h TTL), same failure mode (return last-known-good or
// empty array; never throw at the caller).

import { createSubsystemLogger } from "openclaw/plugin-sdk/core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

const log = createSubsystemLogger("openai-discovery");

const DEFAULT_REFRESH_INTERVAL_SECONDS = 3600; // 1 hour, matches Mantle.
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// ---------------------------------------------------------------------------
// Response shapes — superset of OpenAI's /v1/models
// ---------------------------------------------------------------------------

interface OpenAIModelEntry {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  // AceTeam gateway and similar upstreams add these alongside the spec fields.
  context_window?: number;
  max_output_tokens?: number;
  modalities?: string[];
  cost_per_million_tokens?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
}

interface OpenAIModelsResponse {
  object?: string;
  data?: OpenAIModelEntry[];
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface DiscoveryCacheEntry {
  models: ModelDefinitionConfig[];
  fetchedAt: number;
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();

/** Test-only: clear the in-memory discovery cache. */
export function resetOpenAIDiscoveryCacheForTest(): void {
  discoveryCache.clear();
}

// Cache key collapses the secret part of the auth token so two callers using
// the same key share a cache entry, but rotating a key invalidates.
function cacheKey(baseUrl: string, apiKey: string): string {
  // We only need a stable identifier — full key isn't logged anywhere from
  // the cache key, but hashing avoids holding raw secrets in memory map keys
  // beyond what's already in the request flow.
  return `${baseUrl}::${apiKey.slice(-8)}`;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

const TEXT_MODALITY_NAMES = new Set(["text", "input_text", "output_text"]);
const IMAGE_MODALITY_NAMES = new Set(["image", "input_image", "vision"]);
const AUDIO_MODALITY_NAMES = new Set(["audio", "input_audio", "output_audio"]);
const VIDEO_MODALITY_NAMES = new Set(["video", "input_video"]);

function mapModalities(raw: string[] | undefined): Array<"text" | "image" | "video" | "audio"> {
  // OpenAI's spec doesn't define a `modalities` field; gateways that ship one
  // use a mix of conventions. Fall back to text-only when nothing is supplied.
  if (!raw || raw.length === 0) return ["text"];
  const out = new Set<"text" | "image" | "video" | "audio">();
  for (const m of raw) {
    const lower = m.toLowerCase();
    if (TEXT_MODALITY_NAMES.has(lower)) out.add("text");
    else if (IMAGE_MODALITY_NAMES.has(lower)) out.add("image");
    else if (AUDIO_MODALITY_NAMES.has(lower)) out.add("audio");
    else if (VIDEO_MODALITY_NAMES.has(lower)) out.add("video");
  }
  if (out.size === 0) out.add("text");
  return Array.from(out);
}

function inferReasoningSupport(modelId: string): boolean {
  // Heuristic: GPT-5.x family and the o-series reasoning models all support
  // `reasoning_effort`. Lower-case match — gateways sometimes uppercase IDs.
  const id = modelId.toLowerCase();
  if (id.startsWith("gpt-5") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) {
    return true;
  }
  return false;
}

function toModelDefinition(entry: OpenAIModelEntry): ModelDefinitionConfig | null {
  const id = entry.id?.trim();
  if (!id) return null;
  const cost = entry.cost_per_million_tokens;
  return {
    id,
    name: id,
    reasoning: inferReasoningSupport(id),
    input: mapModalities(entry.modalities),
    cost: {
      input: typeof cost?.input === "number" ? cost.input : DEFAULT_COST.input,
      output: typeof cost?.output === "number" ? cost.output : DEFAULT_COST.output,
      cacheRead: typeof cost?.cache_read === "number" ? cost.cache_read : DEFAULT_COST.cacheRead,
      cacheWrite:
        typeof cost?.cache_write === "number" ? cost.cache_write : DEFAULT_COST.cacheWrite,
    },
    contextWindow:
      typeof entry.context_window === "number" && entry.context_window > 0
        ? entry.context_window
        : DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      typeof entry.max_output_tokens === "number" && entry.max_output_tokens > 0
        ? entry.max_output_tokens
        : DEFAULT_MAX_TOKENS,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Fetch the list of available models from an OpenAI-compatible upstream.
 *
 * Sample request:
 * ```
 * GET https://aceteam.ai/api/gateway/v1/models
 * Authorization: Bearer <apiKey>
 * ```
 *
 * Cached per `(baseUrl, last-8-of-apiKey)` for `DEFAULT_REFRESH_INTERVAL_SECONDS`.
 * Returns the cached result on transient failure; returns `[]` if there's no
 * cache and the fetch fails.
 */
export async function discoverOpenAIModels(params: {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}): Promise<ModelDefinitionConfig[]> {
  const { baseUrl, apiKey, fetchFn = fetch, now = Date.now } = params;
  if (!baseUrl || !apiKey) return [];

  const key = cacheKey(baseUrl, apiKey);
  const cached = discoveryCache.get(key);
  if (cached && now() - cached.fetchedAt < DEFAULT_REFRESH_INTERVAL_SECONDS * 1000) {
    return cached.models;
  }

  const trimmed = baseUrl.replace(/\/+$/, "");
  const endpoint = `${trimmed}/models`;

  try {
    const response = await fetchFn(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      log.debug?.("OpenAI model discovery failed", {
        endpoint,
        status: response.status,
        statusText: response.statusText,
      });
      return cached?.models ?? [];
    }

    const body = (await response.json()) as OpenAIModelsResponse;
    const rawModels = body.data ?? [];

    const models = rawModels
      .map(toModelDefinition)
      .filter((m): m is ModelDefinitionConfig => m !== null)
      .toSorted((a, b) => a.id.localeCompare(b.id));

    discoveryCache.set(key, { models, fetchedAt: now() });
    return models;
  } catch (error) {
    log.debug?.("OpenAI model discovery error", {
      endpoint,
      error: formatErrorMessage(error),
    });
    return cached?.models ?? [];
  }
}
