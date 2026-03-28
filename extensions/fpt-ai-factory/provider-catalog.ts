import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";
import {
  buildFptAiFactoryModelDefinition,
  discoverFptAiFactoryModels,
  FPT_AI_FACTORY_BASE_URL,
  FPT_AI_FACTORY_FALLBACK_MODEL_CATALOG,
} from "./models.js";

export async function buildFptAiFactoryProvider(
  discoveryApiKey?: string,
): Promise<ModelProviderConfig> {
  const trimmedKey = discoveryApiKey?.trim() ?? "";
  const models = trimmedKey
    ? await discoverFptAiFactoryModels(trimmedKey)
    : FPT_AI_FACTORY_FALLBACK_MODEL_CATALOG.map(buildFptAiFactoryModelDefinition);
  return {
    baseUrl: FPT_AI_FACTORY_BASE_URL,
    api: "openai-completions",
    models,
  };
}
