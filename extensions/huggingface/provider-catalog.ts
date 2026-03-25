import {
  buildHuggingfaceModelDefinition,
  discoverHuggingfaceModels,
  type ModelProviderConfig,
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";

export async function buildHuggingfaceProvider(
  discoveryApiKey?: string,
): Promise<ModelProviderConfig> {
  const resolvedSecret = discoveryApiKey?.trim() ?? "";
  const models =
    resolvedSecret !== ""
      ? await discoverHuggingfaceModels(resolvedSecret)
      : HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
  return {
    baseUrl: HUGGINGFACE_BASE_URL,
    api: "openai-completions",
    models,
  };
}
