import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-models";

const MINIMAX_PORTAL_BASE_URL = "https://api.minimax.io/anthropic";
export const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M2.7";
const MINIMAX_DEFAULT_CONTEXT_WINDOW = 200000;
const MINIMAX_DEFAULT_MAX_TOKENS = 8192;
const MINIMAX_API_COST = {
  input: 0.3,
  output: 1.2,
  cacheRead: 0.06,
  cacheWrite: 0.12,
};

function buildMinimaxTextModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
}): ModelDefinitionConfig {
  return {
    id: params.id,
    name: params.name,
    reasoning: params.reasoning,
    input: ["text"],
    cost: MINIMAX_API_COST,
    contextWindow: MINIMAX_DEFAULT_CONTEXT_WINDOW,
    maxTokens: MINIMAX_DEFAULT_MAX_TOKENS,
  };
}

function buildMinimaxCatalog(): ModelDefinitionConfig[] {
  return [
    buildMinimaxTextModel({
      id: MINIMAX_DEFAULT_MODEL_ID,
      name: "MiniMax M2.7",
      reasoning: true,
    }),
    buildMinimaxTextModel({
      id: "MiniMax-M2.7-highspeed",
      name: "MiniMax M2.7 Highspeed",
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
