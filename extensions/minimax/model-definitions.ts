import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { MINIMAX_DEFAULT_MODEL_ID, MINIMAX_TEXT_MODEL_CATALOG } from "./provider-models.js";

export const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";
export const MINIMAX_API_BASE_URL = "https://api.minimax.io/anthropic";
export const MINIMAX_CN_API_BASE_URL = "https://api.minimaxi.com/anthropic";
export const MINIMAX_HOSTED_MODEL_ID = MINIMAX_DEFAULT_MODEL_ID;
export const MINIMAX_HOSTED_MODEL_REF = `minimax/${MINIMAX_HOSTED_MODEL_ID}`;
export const DEFAULT_MINIMAX_CONTEXT_WINDOW = 204800;
export const DEFAULT_MINIMAX_MAX_TOKENS = 131072;

export const MINIMAX_API_COST = {
  input: 0.3,
  output: 1.2,
  cacheRead: 0.06,
  cacheWrite: 0.375,
};
export const MINIMAX_HOSTED_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
export const MINIMAX_LM_STUDIO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

type MinimaxCatalogId = keyof typeof MINIMAX_TEXT_MODEL_CATALOG;

export function buildMinimaxModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  cost: ModelDefinitionConfig["cost"];
  contextWindow: number;
  maxTokens: number;
}): ModelDefinitionConfig {
  const catalog = MINIMAX_TEXT_MODEL_CATALOG[params.id as MinimaxCatalogId];
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? `MiniMax ${params.id}`,
    reasoning: params.reasoning ?? catalog?.reasoning ?? false,
    input: ["text"],
    cost: params.cost,
    contextWindow: params.contextWindow,
    maxTokens: params.maxTokens,
  };
}

export function buildMinimaxApiModelDefinition(modelId: string): ModelDefinitionConfig {
  return buildMinimaxModelDefinition({
    id: modelId,
    cost: MINIMAX_API_COST,
    contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
  });
}
