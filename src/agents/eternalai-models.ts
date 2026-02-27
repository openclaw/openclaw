import type { ModelDefinitionConfig } from "../config/types.js";

export const ETERNALAI_BASE_URL = "https://mvp-b.eternalai.org/v1";
export const ETERNALAI_DEFAULT_MODEL_ID = "openrouter/z-ai/glm-4.7-flash";
export const ETERNALAI_DEFAULT_MODEL_REF = `eternalai/${ETERNALAI_DEFAULT_MODEL_ID}`;

// EternalAI uses credit-based pricing, not per-token costs.
// Set to 0 as costs vary by model and account type.
export const ETERNALAI_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Complete catalog of EternalAI models.
 *
 * EternalAI provides two privacy modes:
 * - "private": Fully private inference, no logging, ephemeral
 * - "anonymized": Proxied through EternalAI with metadata stripped (for proprietary models)
 *
 * Note: The `privacy` field is included for documentation purposes but is not
 * propagated to ModelDefinitionConfig as it's not part of the core model schema.
 * Privacy mode is determined by the model itself, not configurable at runtime.
 *
 * This catalog serves as a fallback when the EternalAI API is unreachable.
 */
export const ETERNALAI_MODEL_CATALOG = [
  {
    id: "openrouter/z-ai/glm-4.7-flash",
    name: "openrouter/z-ai/glm-4.7-flash",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    privacy: "private",
  },
  {
    id: "openrouter/z-ai/glm-4.7",
    name: "openrouter/z-ai/glm-4.7",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    privacy: "private",
  },
] as const;

export type EternalAICatalogEntry = (typeof ETERNALAI_MODEL_CATALOG)[number];

/**
 * Build a ModelDefinitionConfig from an EternalAI catalog entry.
 *
 * Note: The `privacy` field from the catalog is not included in the output
 * as ModelDefinitionConfig doesn't support custom metadata fields. Privacy
 * mode is inherent to each model and documented in the catalog/docs.
 */
export function buildEternalAIModelDefinition(entry: EternalAICatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: ETERNALAI_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

// EternalAI API response types
interface EternalAIModelSpec {
  name: string;
  privacy: "private" | "anonymized";
  availableContextTokens: number;
  capabilities: {
    supportsReasoning: boolean;
    supportsVision: boolean;
    supportsFunctionCalling: boolean;
  };
}

interface EternalAIModel {
  id: string;
  model_spec: EternalAIModelSpec;
}

interface EternalAIModelsResponse {
  data: EternalAIModel[];
}

/**
 * Discover models from EternalAI API with fallback to static catalog.
 * The /models endpoint is public and doesn't require authentication.
 */
export async function discoverEternalAIModels(): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return ETERNALAI_MODEL_CATALOG.map(buildEternalAIModelDefinition);
  }

  try {
    const response = await fetch(`${ETERNALAI_BASE_URL}/models`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn(
        `[eternalai-models] Failed to discover models: HTTP ${response.status}, using static catalog`,
      );
      return ETERNALAI_MODEL_CATALOG.map(buildEternalAIModelDefinition);
    }

    const data = (await response.json()) as EternalAIModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      console.warn("[eternalai-models] No models found from API, using static catalog");
      return ETERNALAI_MODEL_CATALOG.map(buildEternalAIModelDefinition);
    }

    // Merge discovered models with catalog metadata
    const catalogById = new Map<string, EternalAICatalogEntry>(
      ETERNALAI_MODEL_CATALOG.map((m) => [m.id, m]),
    );
    const models: ModelDefinitionConfig[] = [];

    for (const apiModel of data.data) {
      const catalogEntry = catalogById.get(apiModel.id);
      if (catalogEntry) {
        // Use catalog metadata for known models
        models.push(buildEternalAIModelDefinition(catalogEntry));
      } else {
        // Create definition for newly discovered models not in catalog
        const isReasoning =
          Boolean(apiModel.model_spec?.capabilities?.supportsReasoning) ||
          apiModel.id.toLowerCase().includes("thinking") ||
          apiModel.id.toLowerCase().includes("reason") ||
          apiModel.id.toLowerCase().includes("r1");

        const hasVision = Boolean(apiModel.model_spec?.capabilities?.supportsVision);

        models.push({
          id: apiModel.id,
          name: apiModel.model_spec?.name || apiModel.id,
          reasoning: isReasoning,
          input: hasVision ? ["text", "image"] : ["text"],
          cost: ETERNALAI_DEFAULT_COST,
          contextWindow: apiModel.model_spec?.availableContextTokens || 128000,
          maxTokens: 8192,
        });
      }
    }

    return models.length > 0 ? models : ETERNALAI_MODEL_CATALOG.map(buildEternalAIModelDefinition);
  } catch (error) {
    console.warn(`[eternalai-models] Discovery failed: ${String(error)}, using static catalog`);
    return ETERNALAI_MODEL_CATALOG.map(buildEternalAIModelDefinition);
  }
}
