import { type ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_MODEL_CATALOG,
  discoverDeepInfraModels,
} from "./provider-models.js";

export function buildDeepInfraProvider(): ModelProviderConfig {
  return {
    baseUrl: DEEPINFRA_BASE_URL,
    api: "openai-completions",
    models: [...DEEPINFRA_MODEL_CATALOG],
  };
}

export async function buildDeepInfraProviderWithDiscovery(): Promise<ModelProviderConfig> {
  const models = await discoverDeepInfraModels();
  return {
    baseUrl: DEEPINFRA_BASE_URL,
    api: "openai-completions",
    models,
  };
}
