import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildNearAIModelDefinition,
  discoverNearAIModels,
  NEARAI_BASE_URL,
  NEARAI_MODEL_CATALOG,
} from "./models.js";

export function buildStaticNearAIProvider(): ModelProviderConfig {
  return {
    baseUrl: NEARAI_BASE_URL,
    api: "openai-completions",
    models: NEARAI_MODEL_CATALOG.map(buildNearAIModelDefinition),
  };
}

export async function buildNearAIProvider(): Promise<ModelProviderConfig> {
  const models = await discoverNearAIModels();
  return {
    baseUrl: NEARAI_BASE_URL,
    api: "openai-completions",
    models,
  };
}
