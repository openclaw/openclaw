import type { ModelDefinitionConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  MODEL_HUB_BASE_URL,
  MODEL_HUB_DEFAULT_COST,
  MODEL_HUB_STATIC_CATALOG,
} from "../providers/model-hub-shared.js";

const logger = createSubsystemLogger("model-hub-discovery");

const DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Discover available models from Model Hub's `/v1/models` endpoint.
 * Falls back to the static catalog when discovery fails or we're in a test env.
 */
export async function discoverModelHubModels(apiKey?: string): Promise<ModelDefinitionConfig[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return MODEL_HUB_STATIC_CATALOG;
  }

  if (!apiKey) {
    logger.debug("No API key provided for model-hub discovery; using static catalog");
    return MODEL_HUB_STATIC_CATALOG;
  }

  try {
    const response = await fetch(`${MODEL_HUB_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn(`Model Hub discovery returned ${response.status}; using static catalog`);
      return MODEL_HUB_STATIC_CATALOG;
    }

    const body = (await response.json()) as {
      data?: Array<{ id: string; owned_by?: string; supported_endpoint_types?: string[] }>;
    };
    if (!body.data || body.data.length === 0) {
      return MODEL_HUB_STATIC_CATALOG;
    }

    // Only keep models that support OpenAI-compatible endpoints.
    const SUPPORTED_TYPES = new Set(["openai", "openai-responses"]);
    const compatibleModels = body.data.filter((m) =>
      m.supported_endpoint_types?.some((t) => SUPPORTED_TYPES.has(t)),
    );

    if (compatibleModels.length === 0) {
      return MODEL_HUB_STATIC_CATALOG;
    }

    const discoveredModels: ModelDefinitionConfig[] = compatibleModels.map((m) => {
      // Prefer static catalog metadata for known models (better context windows/limits).
      const staticMatch = MODEL_HUB_STATIC_CATALOG.find((s) => s.id === m.id);
      if (staticMatch) {
        return staticMatch;
      }
      return {
        id: m.id,
        name: m.id,
        contextWindow: 128_000,
        maxTokens: 16_384,
        cost: MODEL_HUB_DEFAULT_COST,
        reasoning: /\bo[134]\b/.test(m.id),
        input: ["text"] as Array<"text" | "image">,
      };
    });

    // Append any static catalog models not found in the discovered set.
    const discoveredIds = new Set(discoveredModels.map((m) => m.id));
    for (const staticModel of MODEL_HUB_STATIC_CATALOG) {
      if (!discoveredIds.has(staticModel.id)) {
        discoveredModels.push(staticModel);
      }
    }

    return discoveredModels;
  } catch (err: unknown) {
    logger.warn(`Model Hub discovery failed; using static catalog: ${String(err)}`);
    return MODEL_HUB_STATIC_CATALOG;
  }
}

/**
 * Build the Model Hub provider with dynamic model discovery.
 * Falls back to the static catalog on failure.
 */
export async function buildModelHubProviderWithDiscovery(apiKey?: string): Promise<{
  baseUrl: string;
  api: "openai-completions";
  models: ModelDefinitionConfig[];
}> {
  const models = await discoverModelHubModels(apiKey);
  return {
    baseUrl: MODEL_HUB_BASE_URL,
    api: "openai-completions",
    models,
  };
}
