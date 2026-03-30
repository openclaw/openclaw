import {
  AIMLAPI_BASE_URL,
  discoverAimlapiModels,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/aimlapi";

export async function buildAimlapiProvider(): Promise<ModelProviderConfig> {
  return {
    baseUrl: AIMLAPI_BASE_URL,
    api: "openai-completions",
    models: await discoverAimlapiModels(),
  };
}
