import {
  type ModelProviderConfig,
  discoverDeepInfraModels,
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
