import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { discoverZenmuxModels, ZENMUX_BASE_URL } from "./zenmux-models.js";

export async function buildZenmuxProvider(): Promise<ModelProviderConfig> {
  const models = await discoverZenmuxModels();
  return {
    baseUrl: ZENMUX_BASE_URL,
    api: "openai-completions",
    models,
  };
}
