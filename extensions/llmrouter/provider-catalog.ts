// Llmrouter provider module implements model/runtime integration.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { LLMROUTER_BASE_URL, LLMROUTER_MODEL_CATALOG } from "./models.js";

export function buildLlmrouterProvider(): ModelProviderConfig {
  return {
    baseUrl: LLMROUTER_BASE_URL,
    api: "openai-completions",
    models: LLMROUTER_MODEL_CATALOG,
  };
}
