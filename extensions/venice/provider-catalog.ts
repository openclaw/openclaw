import {
  discoverVeniceModels,
  type ModelProviderConfig,
  VENICE_BASE_URL,
} from "openclaw/plugin-sdk/provider-models";

export async function buildVeniceProvider(): Promise<ModelProviderConfig> {
  const models = await discoverVeniceModels();
  return {
    baseUrl: VENICE_BASE_URL,
    api: "openai-completions",
    models,
  };
}
