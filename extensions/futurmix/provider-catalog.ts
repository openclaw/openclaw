import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildFuturMixModelDefinition,
  FUTURMIX_BASE_URL,
  FUTURMIX_MODEL_CATALOG,
} from "./models.js";

export function buildFuturMixProvider(): ModelProviderConfig {
  return {
    baseUrl: FUTURMIX_BASE_URL,
    api: "openai-completions",
    models: FUTURMIX_MODEL_CATALOG.map(buildFuturMixModelDefinition),
  };
}
