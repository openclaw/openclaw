// AIgateway provider module implements model/runtime integration.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  AIGATEWAY_BASE_URL,
  AIGATEWAY_MODEL_CATALOG,
  buildAigatewayModelDefinition,
} from "./models.js";

export function buildAigatewayProvider(): ModelProviderConfig {
  return {
    baseUrl: AIGATEWAY_BASE_URL,
    api: "openai-completions",
    models: AIGATEWAY_MODEL_CATALOG.map(buildAigatewayModelDefinition),
  };
}
