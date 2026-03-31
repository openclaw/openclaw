import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { applyMistralModelCompat } from "./model-compat.js";
import { buildMistralCatalogModels, MISTRAL_BASE_URL } from "./model-definitions.js";

export function buildMistralProvider(): ModelProviderConfig {
  return {
    baseUrl: MISTRAL_BASE_URL,
    api: "openai-completions",
    // Apply compat patch to all catalog models to prevent 422 errors when users
    // manually select models like codestral-latest or mistral-small-latest
    models: buildMistralCatalogModels().map((model) => applyMistralModelCompat(model)),
  };
}
