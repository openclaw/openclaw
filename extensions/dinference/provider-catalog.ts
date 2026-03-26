import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildDinferenceModelDefinition,
  DINFERENCE_BASE_URL,
  DINFERENCE_MODEL_CATALOG,
} from "./models.ts";

export function buildDinferenceProvider(): ModelProviderConfig {
  return {
    baseUrl: DINFERENCE_BASE_URL,
    api: "openai-completions",
    models: DINFERENCE_MODEL_CATALOG.map(buildDinferenceModelDefinition),
  };
}
