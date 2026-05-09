import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  NOVITA_BASE_URL,
  buildNovitaModelDefinition,
  discoverNovitaModels,
  NOVITA_MODEL_CATALOG,
} from "./models.js";

export function buildStaticNovitaProvider(): ModelProviderConfig {
  return {
    baseUrl: NOVITA_BASE_URL,
    api: "openai-completions",
    models: NOVITA_MODEL_CATALOG.map(buildNovitaModelDefinition),
  };
}

export async function buildNovitaProvider(discoveryApiKey?: string): Promise<ModelProviderConfig> {
  return {
    baseUrl: NOVITA_BASE_URL,
    api: "openai-completions",
    models: await discoverNovitaModels(discoveryApiKey),
  };
}
