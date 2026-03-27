import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";
import { discoverVeniceModels, VENICE_BASE_URL } from "./api.js";

export async function buildVeniceProvider(): Promise<ModelProviderConfig> {
  const models = await discoverVeniceModels();
  return {
    baseUrl: VENICE_BASE_URL,
    api: "openai-completions",
    models,
  };
}
