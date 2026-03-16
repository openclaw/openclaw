import {
    DEEPINFRA_BASE_URL,
} from "../providers/deepinfra-shared.ts";

import {
    discoverDeepInfraModels,
    buildStaticCatalog
 } from "./deepinfra-models.js";

export async function buildDeepInfraProviderWithDiscovery(): Promise<ProviderConfig> {
  const models = await discoverDeepInfraModels();
  return {
    baseUrl: DEEPINFRA_BASE_URL,
    api: "openai-completions",
    models,
  };
}

export function buildDeepInfraStaticProvider(): ProviderConfig {
  return {
    baseUrl: DEEPINFRA_BASE_URL,
    api: "openai-completions",
    models: buildStaticCatalog(),
  };
}
