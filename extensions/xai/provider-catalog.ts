import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";
import { buildXaiCatalogModels, XAI_BASE_URL } from "./model-definitions.js";

export function buildXaiProvider(
  api: ModelProviderConfig["api"] = "openai-completions",
): ModelProviderConfig {
  return {
    baseUrl: XAI_BASE_URL,
    api,
    models: buildXaiCatalogModels(),
  };
}
