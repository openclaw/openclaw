import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  discoverInworldModels,
  INWORLD_COMPLETIONS_URL,
  INWORLD_FALLBACK_CATALOG,
} from "./models.js";

export function buildStaticInworldProvider(): ModelProviderConfig {
  return {
    baseUrl: INWORLD_COMPLETIONS_URL,
    api: "openai-completions",
    models: INWORLD_FALLBACK_CATALOG,
  };
}

export async function buildInworldProvider(apiKey?: string): Promise<ModelProviderConfig> {
  const models = await discoverInworldModels(apiKey);
  return {
    baseUrl: INWORLD_COMPLETIONS_URL,
    api: "openai-completions",
    models,
  };
}
