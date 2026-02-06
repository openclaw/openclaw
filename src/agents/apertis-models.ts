import type { ModelDefinitionConfig } from "../config/types.js";

export const APERTIS_BASE_URL = "https://api.apertis.ai/v1";
export const APERTIS_DISCOVERY_URL = "https://api.apertis.ai/api/models";
export const APERTIS_DEFAULT_CONTEXT_WINDOW = 128000;
export const APERTIS_DEFAULT_MAX_TOKENS = 8192;
export const APERTIS_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

interface ApertisModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface ApertisModelsResponse {
  data: ApertisModel[];
}

/**
 * Heuristic: detect reasoning models by ID pattern.
 *
 * Matches IDs containing reasoning-related tokens like "r1", "o1", "o3",
 * "o4", "thinking", or "reasoning". Guards against false positives from
 * "4o" models (those are vision, not reasoning).
 */
export function isApertisReasoningModel(id: string): boolean {
  const lower = id.toLowerCase();
  // "4o" models (e.g. gpt-4o) are vision, not reasoning
  if (lower.includes("4o")) {
    return false;
  }
  return /(?:reasoning|think(?:ing)?|(?:^|-)r1(?:$|-)|(?:^|-)o[134](?:$|-))/.test(lower);
}

/**
 * Heuristic: detect vision models by ID pattern.
 *
 * Matches IDs containing vision-related tokens like "vision", "vl",
 * or the "4o" family (gpt-4o, gpt-4o-mini, etc.).
 */
export function isApertisVisionModel(id: string): boolean {
  return /(?:vision|(?:^|-)vl(?:$|-)|4o(?:$|-))/.test(id.toLowerCase());
}

/**
 * Discover models from the Apertis AI public API.
 *
 * The endpoint at /api/models returns an OpenAI-compatible model list
 * and does not require authentication. Returns an empty array on failure
 * (no static catalog fallback — Apertis models are fully dynamic).
 */
export async function discoverApertisModels(): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [];
  }

  try {
    const response = await fetch(APERTIS_DISCOVERY_URL, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn(`[apertis-models] Failed to discover models: HTTP ${response.status}`);
      return [];
    }

    const data = (await response.json()) as ApertisModelsResponse;
    const models = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data)
        ? (data as unknown as ApertisModel[])
        : [];

    if (models.length === 0) {
      console.warn("[apertis-models] No models found from API");
      return [];
    }

    return models.map((model: ApertisModel) => {
      const isReasoning = isApertisReasoningModel(model.id);
      const isVision = isApertisVisionModel(model.id);
      return {
        id: model.id,
        name: model.id,
        reasoning: isReasoning,
        input: isVision
          ? (["text", "image"] as Array<"text" | "image">)
          : (["text"] as Array<"text" | "image">),
        cost: APERTIS_DEFAULT_COST,
        contextWindow: APERTIS_DEFAULT_CONTEXT_WINDOW,
        maxTokens: APERTIS_DEFAULT_MAX_TOKENS,
      };
    });
  } catch (error) {
    console.warn(`[apertis-models] Discovery failed: ${String(error)}`);
    return [];
  }
}
