import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildUpstageModelDefinition, UPSTAGE_BASE_URL, UPSTAGE_MODEL_CATALOG } from "./models.js";

export function buildUpstageProvider(): ModelProviderConfig {
  return {
    baseUrl: UPSTAGE_BASE_URL,
    api: "openai-completions",
    models: UPSTAGE_MODEL_CATALOG.map(buildUpstageModelDefinition),
  };
}
