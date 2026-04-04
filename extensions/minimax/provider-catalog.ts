import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  DEFAULT_MINIMAX_CONTEXT_WINDOW,
  DEFAULT_MINIMAX_MAX_TOKENS,
  resolveMinimaxApiCost,
} from "./model-definitions.js";
import { MINIMAX_TEXT_MODEL_CATALOG, MINIMAX_TEXT_MODEL_ORDER } from "./provider-models.js";

const MINIMAX_PORTAL_BASE_URL = "https://api.minimax.io/anthropic";

function buildMinimaxModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
  input: ModelDefinitionConfig["input"];
  cost: ModelDefinitionConfig["cost"];
}): ModelDefinitionConfig {
  return {
    id: params.id,
    name: params.name,
    reasoning: params.reasoning,
    input: params.input,
    cost: params.cost,
    contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
  };
}

function buildMinimaxTextModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
  cost: ModelDefinitionConfig["cost"];
}): ModelDefinitionConfig {
  return buildMinimaxModel({ ...params, input: ["text"] });
}

function buildMinimaxCatalog(): ModelDefinitionConfig[] {
  return MINIMAX_TEXT_MODEL_ORDER.map((id) => {
    const model = MINIMAX_TEXT_MODEL_CATALOG[id];
    return buildMinimaxTextModel({
      id,
      name: model.name,
      reasoning: model.reasoning,
      cost: resolveMinimaxApiCost(id),
    });
  });
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
