import type { ModelDefinitionConfig, ModelProviderConfig } from "../../src/config/types.models.js";

const MINIMAX_PORTAL_BASE_URL = "https://api.minimax.io/anthropic";
export const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M2.5";
const MINIMAX_DEFAULT_VISION_MODEL_ID = "MiniMax-VL-01";
const MINIMAX_DEFAULT_CONTEXT_WINDOW = 200000;
const MINIMAX_DEFAULT_MAX_TOKENS = 8192;
const MINIMAX_API_COST = {
  input: 0.3,
  output: 1.2,
  cacheRead: 0.03,
  cacheWrite: 0.12,
};

function buildMinimaxModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
  input: ModelDefinitionConfig["input"];
}): ModelDefinitionConfig {
  return {
    id: params.id,
    name: params.name,
    reasoning: params.reasoning,
    input: params.input,
    cost: MINIMAX_API_COST,
    contextWindow: MINIMAX_DEFAULT_CONTEXT_WINDOW,
    maxTokens: MINIMAX_DEFAULT_MAX_TOKENS,
  };
}

function buildMinimaxTextModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
}): ModelDefinitionConfig {
  return buildMinimaxModel({ ...params, input: ["text"] });
}

function buildMinimaxCatalog(): ModelDefinitionConfig[] {
  return [
    buildMinimaxModel({
      id: MINIMAX_DEFAULT_VISION_MODEL_ID,
      name: "MiniMax VL 01",
      reasoning: false,
      input: ["text", "image"],
    }),
    buildMinimaxTextModel({
      id: MINIMAX_DEFAULT_MODEL_ID,
      name: "MiniMax M2.5",
      reasoning: true,
    }),
    buildMinimaxTextModel({
      id: "MiniMax-M2.5-highspeed",
      name: "MiniMax M2.5 Highspeed",
      reasoning: true,
    }),
  ];
}

export function buildMinimaxProvider(): ModelProviderConfig {
  return {
    baseUrl: MINIMAX_PORTAL_BASE_URL,
    api: "anthropic-messages",
    authHeader: true,
    models: buildMinimaxCatalog(),
  };
}

export function buildMinimaxPortalProvider(): ModelProviderConfig {
  return {
    baseUrl: MINIMAX_PORTAL_BASE_URL,
    api: "anthropic-messages",
    authHeader: true,
    models: buildMinimaxCatalog(),
  };
}
