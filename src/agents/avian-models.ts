import type { ModelDefinitionConfig } from "../config/types.js";
import { retryAsync } from "../infra/retry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("avian-models");

export const AVIAN_BASE_URL = "https://api.avian.io/v1";
export const AVIAN_DEFAULT_MODEL_ID = "deepseek/deepseek-v3.2";
export const AVIAN_DEFAULT_MODEL_REF = `avian/${AVIAN_DEFAULT_MODEL_ID}`;

export const AVIAN_DEFAULT_COST = {
  input: 0.26,
  output: 0.38,
  cacheRead: 0,
  cacheWrite: 0,
};

const AVIAN_DISCOVERY_TIMEOUT_MS = 10_000;
const AVIAN_DISCOVERY_RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Static catalog of Avian models — used as fallback when discovery fails.
 */
export const AVIAN_MODEL_CATALOG = [
  {
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek V3.2",
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 0.26, output: 0.38, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 164000,
    maxTokens: 65536,
  },
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.45, output: 2.2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131000,
    maxTokens: 8192,
  },
  {
    id: "z-ai/glm-5",
    name: "GLM 5",
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 0.3, output: 2.55, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131000,
    maxTokens: 16384,
  },
  {
    id: "minimax/minimax-m2.5",
    name: "MiniMax M2.5",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0.3, output: 1.1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 1000000,
  },
];

export type AvianCatalogEntry = (typeof AVIAN_MODEL_CATALOG)[number];

export function buildAvianModelDefinition(entry: AvianCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: entry.cost,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

// OpenAI-compatible /v1/models response types
interface AvianApiModel {
  id: string;
  object: string;
  owned_by?: string;
  display_name?: string;
  context_length?: number;
  max_output?: number;
  reasoning?: boolean;
  pricing?: {
    input_per_million?: number;
    output_per_million?: number;
    cache_read_per_million?: number;
  };
}

interface AvianModelsResponse {
  object: string;
  data: AvianApiModel[];
}

class AvianDiscoveryHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "AvianDiscoveryHttpError";
    this.status = status;
  }
}

function staticAvianModelDefinitions(): ModelDefinitionConfig[] {
  return AVIAN_MODEL_CATALOG.map(buildAvianModelDefinition);
}

function isRetryableAvianDiscoveryError(err: unknown): boolean {
  if (err instanceof AvianDiscoveryHttpError) {
    return AVIAN_DISCOVERY_RETRYABLE_HTTP_STATUS.has(err.status);
  }
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  if (err instanceof TypeError && err.message.toLowerCase() === "fetch failed") {
    return true;
  }
  return false;
}

/**
 * Discover models from Avian's /v1/models endpoint with fallback to static catalog.
 * The endpoint is public and doesn't require authentication.
 */
export async function discoverAvianModels(): Promise<ModelDefinitionConfig[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return staticAvianModelDefinitions();
  }

  try {
    const response = await retryAsync(
      async () => {
        const currentResponse = await fetch(`${AVIAN_BASE_URL}/models`, {
          signal: AbortSignal.timeout(AVIAN_DISCOVERY_TIMEOUT_MS),
          headers: { Accept: "application/json" },
        });
        if (
          !currentResponse.ok &&
          AVIAN_DISCOVERY_RETRYABLE_HTTP_STATUS.has(currentResponse.status)
        ) {
          throw new AvianDiscoveryHttpError(currentResponse.status);
        }
        return currentResponse;
      },
      {
        attempts: 3,
        minDelayMs: 300,
        maxDelayMs: 2000,
        jitter: 0.2,
        label: "avian-model-discovery",
        shouldRetry: isRetryableAvianDiscoveryError,
      },
    );

    if (!response.ok) {
      log.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
      return staticAvianModelDefinitions();
    }

    const data = (await response.json()) as AvianModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      log.warn("No models found from API, using static catalog");
      return staticAvianModelDefinitions();
    }

    const catalogById = new Map<string, AvianCatalogEntry>(
      AVIAN_MODEL_CATALOG.map((m) => [m.id, m]),
    );
    const models: ModelDefinitionConfig[] = [];

    for (const apiModel of data.data) {
      const catalogEntry = catalogById.get(apiModel.id);
      if (catalogEntry) {
        models.push(buildAvianModelDefinition(catalogEntry));
      } else {
        // Newly discovered model not in static catalog — infer metadata
        const isReasoning =
          apiModel.reasoning === true ||
          apiModel.id.toLowerCase().includes("thinking") ||
          apiModel.id.toLowerCase().includes("reason");

        const cost = apiModel.pricing
          ? {
              input: apiModel.pricing.input_per_million ?? 0,
              output: apiModel.pricing.output_per_million ?? 0,
              cacheRead: apiModel.pricing.cache_read_per_million ?? 0,
              cacheWrite: 0,
            }
          : AVIAN_DEFAULT_COST;

        models.push({
          id: apiModel.id,
          name: apiModel.display_name || apiModel.id,
          reasoning: isReasoning,
          input: ["text"],
          cost,
          contextWindow: apiModel.context_length || 128000,
          maxTokens: apiModel.max_output || 8192,
        });
      }
    }

    return models.length > 0 ? models : staticAvianModelDefinitions();
  } catch (error) {
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return staticAvianModelDefinitions();
  }
}
