import {
  type ModelProviderConfig,
  buildDeepInfraStaticCatalog,
  discoverDeepInfraModels,
  DEEPINFRA_BASE_URL,
} from "openclaw/plugin-sdk/provider-models";

export function buildDeepInfraStaticProvider(): ModelProviderConfig {
  return {
    baseUrl: DEEPINFRA_BASE_URL,
    api: "openai-completions",
    models: buildDeepInfraStaticCatalog(),
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
