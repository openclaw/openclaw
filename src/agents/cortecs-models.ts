import type { ModelDefinitionConfig } from "../config/types.js";

/**
 * ---------------------------------------------------------------------------
 * Cortecs constants
 * ---------------------------------------------------------------------------
 */

export const CORTECS_BASE_URL = "https://api.cortecs.ai/v1/";
export const CORTECS_MODELS_URL = `${CORTECS_BASE_URL}models?tag=Instruct`;

export const CORTECS_DEFAULT_MODEL_ID = "gpt-oss-120b";
export const CORTECS_DEFAULT_MODEL_REF = `cortecs/${CORTECS_DEFAULT_MODEL_ID}`;
export const CORTECS_DEFAULT_CONTEXT_WINDOW = 128000;
export const CORTECS_DEFAULT_MAX_TOKENS = 8192;
export const CORTECS_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * ---------------------------------------------------------------------------
 * Cortecs /v1/models response types
 * ---------------------------------------------------------------------------
 */
interface CortecsPricing {
  input_token: number;
  output_token: number;
  currency: string;
}

interface CortecsModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  description?: string;
  pricing?: CortecsPricing;
  context_size?: number;
  tags?: string[];
  max_tokens?: number;
}

interface CortecsModelsResponse {
  object: "list";
  data: CortecsModel[];
}

/**
 * ---------------------------------------------------------------------------
 * Default Cortecs model definition (fallback)
 * ---------------------------------------------------------------------------
 */
function getDefaultCortecsModel(): ModelDefinitionConfig {
  return {
    id: CORTECS_DEFAULT_MODEL_ID,
    name: "GPT Oss 120b",
    reasoning: true,
    input: ["text"],
    cost: CORTECS_DEFAULT_COST,
    contextWindow: CORTECS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: CORTECS_DEFAULT_MAX_TOKENS,
  };
}

/**
 * ---------------------------------------------------------------------------
 * Discover models from Cortecs /v1/models (with fallback)
 * ---------------------------------------------------------------------------
 */
export async function discoverCortecsModels(): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [getDefaultCortecsModel()];
  }

  try {
    const res = await fetch(CORTECS_MODELS_URL, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(
        `[cortecs-models] Failed to discover models: HTTP ${res.status}, using default model`,
      );
      return [getDefaultCortecsModel()];
    }

    const payload = (await res.json()) as CortecsModelsResponse;

    if (!Array.isArray(payload.data) || payload.data.length === 0) {
      console.warn("[cortecs-models] No models found from catalog, using default model");
      return [getDefaultCortecsModel()];
    }

    const models: ModelDefinitionConfig[] = payload.data.map((m) => {
      const tags = m.tags ?? [];
      const tagsLower = new Set(tags.map((t) => t.toLowerCase()));

      const reasoning = tagsLower.has("reasoning");
      const hasVision = tagsLower.has("image");

      return {
        id: m.id,
        name: m.id,
        reasoning,
        input: hasVision ? ["text", "image"] : ["text"],
        cost: {
          input: Number.isFinite(m.pricing?.input_token) ? (m.pricing?.input_token ?? 0) : 0,
          output: Number.isFinite(m.pricing?.output_token) ? (m.pricing?.output_token ?? 0) : 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: m.context_size ?? CORTECS_DEFAULT_CONTEXT_WINDOW,
        maxTokens: m.max_tokens ?? CORTECS_DEFAULT_MAX_TOKENS,
      } satisfies ModelDefinitionConfig;
    });
    return models.length > 0 ? models : [getDefaultCortecsModel()];
  } catch (error) {
    console.warn(`[cortecs-models] Discovery failed: ${String(error)}, using default model`);
    return [getDefaultCortecsModel()];
  }
}
