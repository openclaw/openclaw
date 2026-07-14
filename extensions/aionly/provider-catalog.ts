/**
 * AIOnly model provider builder.
 */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildAIOnlyCatalogModels, AIONLY_BASE_URL } from "./models.js";

/** Builds the AIOnly OpenAI-compatible model provider config. */
export function buildAIOnlyProvider(): ModelProviderConfig {
  return {
    baseUrl: AIONLY_BASE_URL,
    api: "openai-completions",
    models: buildAIOnlyCatalogModels(),
  };
}
