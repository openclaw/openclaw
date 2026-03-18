import {
  type ModelProviderConfig,
  discoverDeepInfraModels,
  buildDeepInfraStaticCatalog,
  DEEPINFRA_BASE_URL,
} from "openclaw/plugin-sdk/provider-models";

export async function buildDeepInfraProviderWithDiscovery(): Promise<ModelProviderConfig> {
  const models = await discoverDeepInfraModels();
  return {
    baseUrl: DEEPINFRA_BASE_URL,
    api: "openai-completions",
    models,
  };
}

export function buildDeepInfraStaticProvider(): ModelProviderConfig {
  return {
    baseUrl: DEEPINFRA_BASE_URL,
    api: "openai-completions",
    models: buildDeepInfraStaticCatalog(),
  };
}
