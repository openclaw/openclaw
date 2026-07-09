/**
 * Meta Model API model provider builder.
 */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildMetaModelApiCatalogModels, META_MODEL_API_BASE_URL } from "./models.js";

/** Builds the Meta Model API OpenAI-compatible model provider config. */
export function buildMetaModelApiProvider(): ModelProviderConfig {
  return {
    baseUrl: META_MODEL_API_BASE_URL,
    api: "openai-responses",
    models: buildMetaModelApiCatalogModels(),
  };
}
