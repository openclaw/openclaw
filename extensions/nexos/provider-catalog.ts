import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { discoverNexosModels, NEXOS_BASE_URL } from "./api.js";

export async function buildNexosProvider(discoveryApiKey?: string): Promise<ModelProviderConfig> {
  const models = await discoverNexosModels(discoveryApiKey);
  return {
    baseUrl: NEXOS_BASE_URL,
    api: "openai-completions",
    models,
  };
}
