import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const log = createSubsystemLogger("deepinfra-models");

/**
 * DeepInfra OpenAI-compatible API base URL.
 *
 * Stored without a trailing slash so the persisted provider config matches
 * OpenAI-compat convention (baseUrl + "/chat/completions" → valid endpoint).
 * A trailing slash here would cause the generic openai-completions config
 * normalizer to append "/v1" (yielding ".../v1/openai/v1"), breaking inference.
 * See `provider-policy-api.ts` for the passthrough hook that keeps this URL
 * shape out of the generic normalizer entirely.
 */
export const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";

export const DEEPINFRA_DEFAULT_MODEL_ID = "zai-org/GLM-5.1";
export const DEEPINFRA_DEFAULT_MODEL_REF = `deepinfra/${DEEPINFRA_DEFAULT_MODEL_ID}`;

/** Default context window and max tokens for discovered models. */
export const DEEPINFRA_DEFAULT_CONTEXT_WINDOW = 128000;
export const DEEPINFRA_DEFAULT_MAX_TOKENS = 8192;

/**
 * Static catalog of popular DeepInfra models.
 * Used as a fallback when discovery is unavailable.
 */
export const DEEPINFRA_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "zai-org/GLM-5.1",
    name: "GLM-5.1",
    reasoning: true,
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 202752,
    cost: {
      input: 1.4,
      output: 4.4,
      cacheRead: 0.26,
      cacheWrite: 0,
    },
  },
  {
    id: "stepfun-ai/Step-3.5-Flash",
    name: "Step 3.5 Flash",
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 262144,
    cost: {
      input: 0.1,
      output: 0.3,
      cacheRead: 0.02,
      cacheWrite: 0,
    },
  },
  {
    id: "MiniMaxAI/MiniMax-M2.5",
    name: "MiniMax M2.5",
    reasoning: true,
    input: ["text"],
    contextWindow: 196608,
    maxTokens: 196608,
    cost: {
      input: 0.27,
      output: 0.95,
      cacheRead: 0.03,
      cacheWrite: 0,
    },
  },
  {
    id: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B",
    name: "NVIDIA Nemotron 3 Super 120B A12B",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 262144,
    cost: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
  {
    id: "moonshotai/Kimi-K2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 262144,
    cost: {
      input: 0.45,
      output: 2.25,
      cacheRead: 0.07,
      cacheWrite: 0,
    },
  },
];

// Query params are DeepInfra server-side contracts; if either is renamed
// upstream the catalog still parses but silently changes order/scope:
//  - sort_by=openclaw: curated ranking used by `preserveDiscoveryOrder: true`
//    on the catalog hook. Without it the catalog falls back to API insertion
//    order, which may not be meaningful.
//  - filter=with_meta: excludes non-LLM entries (embeddings, image-gen, audio)
//    server-side. If dropped, the client still skips entries with null
//    metadata in `discoverDeepInfraModels`, but the response grows.
export const DEEPINFRA_MODELS_URL = `${DEEPINFRA_BASE_URL}/models?sort_by=openclaw&filter=with_meta`;

const DISCOVERY_TIMEOUT_MS = 5000;

// Coalesces adjacent calls from the onboarding auth method and later
// `catalog.run` into a single /models round trip. 30 min is long enough to
// cover that window comfortably while still letting a new upstream model
// appear in `openclaw models list` within the same CLI session.
const DISCOVERY_CACHE_TTL_MS = 30 * 60 * 1000;

let cachedModels: ModelDefinitionConfig[] | null = null;
let cachedAt = 0;

/**
 * Drops the in-memory discovery cache. Vitest uses module-scoped state
 * across cases within a file, so tests that exercise the fetch path must
 * reset between cases to keep assertions independent.
 */
export function resetDeepInfraModelCacheForTest(): void {
  cachedModels = null;
  cachedAt = 0;
}

// ---------------------------------------------------------------------------
// API response types (DeepInfra OpenAI-compatible /models schema)
// ---------------------------------------------------------------------------

interface DeepInfraModelPricing {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
}

interface DeepInfraModelMetadata {
  description?: string;
  context_length?: number;
  max_tokens?: number;
  pricing?: DeepInfraModelPricing;
  /** e.g. ["vision", "reasoning_effort", "prompt_cache", "reasoning"] */
  tags?: string[];
}

interface DeepInfraModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  metadata: DeepInfraModelMetadata | null;
}

interface DeepInfraModelsResponse {
  data: DeepInfraModelEntry[];
}

// ---------------------------------------------------------------------------
// Model parsing
// ---------------------------------------------------------------------------

function parseModality(metadata: DeepInfraModelMetadata): Array<"text" | "image"> {
  const hasVision = metadata.tags?.includes("vision") ?? false;
  return hasVision ? ["text", "image"] : ["text"];
}

function parseReasoning(metadata: DeepInfraModelMetadata): boolean {
  return (
    (metadata.tags?.includes("reasoning_effort") || metadata.tags?.includes("reasoning")) ?? false
  );
}

function toModelDefinition(entry: DeepInfraModelEntry): ModelDefinitionConfig {
  const meta = entry.metadata!;
  return {
    id: entry.id,
    name: entry.id,
    reasoning: parseReasoning(meta),
    input: parseModality(meta),
    cost: {
      input: meta.pricing?.input_tokens ?? 0,
      output: meta.pricing?.output_tokens ?? 0,
      cacheRead: meta.pricing?.cache_read_tokens ?? 0,
      cacheWrite: 0,
    },
    contextWindow: meta.context_length ?? DEEPINFRA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: meta.max_tokens ?? DEEPINFRA_DEFAULT_MAX_TOKENS,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover models from the DeepInfra API with fallback to static catalog.
 * Skips models with null metadata (embeddings, image-gen, etc.).
 *
 * When discovery succeeds, only discovered models are returned (no merge
 * with the static catalog). The API is the single source of truth.
 */
export async function discoverDeepInfraModels(): Promise<ModelDefinitionConfig[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return [...DEEPINFRA_MODEL_CATALOG];
  }

  if (cachedModels && Date.now() - cachedAt < DISCOVERY_CACHE_TTL_MS) {
    return [...cachedModels];
  }

  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: DEEPINFRA_MODELS_URL,
      init: { headers: { Accept: "application/json" } },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      auditContext: "deepinfra-model-discovery",
    });

    try {
      if (!response.ok) {
        log.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
        return [...DEEPINFRA_MODEL_CATALOG];
      }

      const data = (await response.json()) as DeepInfraModelsResponse;
      if (!Array.isArray(data.data) || data.data.length === 0) {
        log.warn("No models found from DeepInfra API, using static catalog");
        return [...DEEPINFRA_MODEL_CATALOG];
      }

      const models: ModelDefinitionConfig[] = [];
      const discoveredIds = new Set<string>();

      for (const entry of data.data) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        if (!id || discoveredIds.has(id)) {
          continue;
        }
        // Skip non-completion models (embeddings, image-gen, etc.)
        if (!entry.metadata) {
          continue;
        }
        try {
          models.push(toModelDefinition(entry));
          discoveredIds.add(id);
        } catch (e) {
          log.warn(`Skipping malformed model entry "${id}": ${String(e)}`);
        }
      }

      if (models.length === 0) {
        return [...DEEPINFRA_MODEL_CATALOG];
      }
      // Only populate the cache on a successful live response — static-catalog
      // fallbacks stay uncached so transient failures self-heal on the next
      // call instead of pinning the fallback for 30 min.
      cachedModels = models;
      cachedAt = Date.now();
      return [...models];
    } finally {
      await release();
    }
  } catch (error) {
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return [...DEEPINFRA_MODEL_CATALOG];
  }
}

/**
 * Resolve the onboarded default model ref against the discovered catalog.
 *
 * Prefers `DEEPINFRA_DEFAULT_MODEL_ID` when it appears in the discovered
 * catalog, otherwise falls back to the first discovered model. Prevents a
 * post-onboarding "unknown model" state when the upstream /models response no
 * longer includes the preferred default (deprecation, region filtering, or a
 * curated list change). Shares `discoverDeepInfraModels`'s TTL cache so a
 * subsequent `catalog.run` in the same window does not refetch.
 */
export async function resolveDeepInfraDefaultModelRef(): Promise<string> {
  const models = await discoverDeepInfraModels();
  if (models.some((m) => m.id === DEEPINFRA_DEFAULT_MODEL_ID)) {
    return DEEPINFRA_DEFAULT_MODEL_REF;
  }
  const first = models[0];
  return first ? `deepinfra/${first.id}` : DEEPINFRA_DEFAULT_MODEL_REF;
}
