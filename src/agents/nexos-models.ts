import type { ModelDefinitionConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("nexos-models");

export const NEXOS_BASE_URL = "https://api.nexos.ai/v1";
export const NEXOS_DEFAULT_MODEL_ID = "Claude Opus 4.6";
export const NEXOS_DEFAULT_MODEL_REF = `nexos/${NEXOS_DEFAULT_MODEL_ID}`;

// Nexos AI pricing is not publicly documented per-token.
// Set to 0 as a safe default.
export const NEXOS_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Static catalog of Nexos AI models.
 * Serves as a fallback when the Nexos API is unreachable or requires auth.
 *
 * Nexos is an OpenAI-compatible gateway that proxies multiple providers
 * (Anthropic, OpenAI, Google, xAI) through a unified API.
 */
export const NEXOS_MODEL_CATALOG = [
  {
    id: "Claude Opus 4.6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 200_000,
    maxTokens: 128_000,
  },
  {
    id: "Claude Opus 4.5",
    name: "Claude Opus 4.5",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 200_000,
    maxTokens: 128_000,
  },
  {
    id: "Claude Sonnet 4.6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: "Claude Sonnet 4.5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: "Claude Haiku 4.5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    id: "GPT 5.2",
    name: "GPT 5.2",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 128_000,
    maxTokens: 32_768,
  },
  {
    id: "GPT 5",
    name: "GPT 5",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 128_000,
    maxTokens: 32_768,
  },
  {
    id: "GPT 4.1",
    name: "GPT 4.1",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 1_000_000,
    maxTokens: 32_768,
  },
  {
    id: "Gemini 3 Flash Preview",
    name: "Gemini 3 Flash Preview",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: "Gemini 2.5 Pro",
    name: "Gemini 2.5 Pro",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: "Grok 4 Fast",
    name: "Grok 4 Fast",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 128_000,
    maxTokens: 32_768,
  },
  {
    id: "Devstral 2",
    name: "Devstral 2",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 128_000,
    maxTokens: 32_768,
  },
];

export type NexosCatalogEntry = (typeof NEXOS_MODEL_CATALOG)[number];

export function buildNexosModelDefinition(entry: NexosCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: NEXOS_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

/** Shape of a single model entry from GET /v1/models on the Nexos API. */
interface NexosApiModelEntry {
  id: string;
  name?: string;
  owned_by?: string;
  object?: string;
  nexos_model_id?: string;
}

/** Response shape from GET /v1/models (OpenAI-style list). */
interface OpenAIListModelsResponse {
  data?: NexosApiModelEntry[];
  object?: string;
  total?: number;
}

/** Defaults for models discovered from the API that are not in the static catalog. */
const NEXOS_DEFAULT_CONTEXT_WINDOW = 128_000;
const NEXOS_DEFAULT_MAX_TOKENS = 8192;

/**
 * Discover models from the Nexos AI API (GET /v1/models).
 * Requires a valid API key (Bearer auth). Falls back to static catalog on failure or in test env.
 */
export async function discoverNexosModels(apiKey: string): Promise<ModelDefinitionConfig[]> {
  const staticFallback = () => NEXOS_MODEL_CATALOG.map(buildNexosModelDefinition);

  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return staticFallback();
  }

  const trimmedKey = apiKey?.trim();
  if (!trimmedKey) {
    return staticFallback();
  }

  try {
    const response = await fetch(`${NEXOS_BASE_URL}/models`, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${trimmedKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      log.warn(`GET /v1/models failed: HTTP ${response.status}, using static catalog`);
      return staticFallback();
    }

    const body = (await response.json()) as OpenAIListModelsResponse;
    const data = body?.data;
    if (!Array.isArray(data) || data.length === 0) {
      log.warn("No models in response, using static catalog");
      return staticFallback();
    }

    const catalogById = new Map(NEXOS_MODEL_CATALOG.map((m) => [m.id, m] as const));
    const seen = new Set<string>();
    const models: ModelDefinitionConfig[] = [];

    for (const entry of data) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);

      const catalogEntry = catalogById.get(id);
      if (catalogEntry) {
        models.push(buildNexosModelDefinition(catalogEntry));
      } else {
        const name = (typeof entry.name === "string" && entry.name.trim()) || id;
        models.push({
          id,
          name,
          reasoning: false,
          input: ["text"],
          cost: NEXOS_DEFAULT_COST,
          contextWindow: NEXOS_DEFAULT_CONTEXT_WINDOW,
          maxTokens: NEXOS_DEFAULT_MAX_TOKENS,
        });
      }
    }

    return models.length > 0 ? models : staticFallback();
  } catch (error) {
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return staticFallback();
  }
}
