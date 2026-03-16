import {
  buildClawApiModelDefinition,
  CLAWAPI_BASE_URL,
  CLAWAPI_MODEL_CATALOG,
} from "openclaw/plugin-sdk/provider-models";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";

export function buildClawApiProvider(): ModelProviderConfig {
  return {
    baseUrl: CLAWAPI_BASE_URL,
    api: "openai-completions",
    models: CLAWAPI_MODEL_CATALOG.map(buildClawApiModelDefinition),
  };
}
