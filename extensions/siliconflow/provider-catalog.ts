import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildSiliconFlowModelDefinition,
  SILICONFLOW_BASE_URL,
  SILICONFLOW_MODEL_CATALOG,
} from "./api.js";

export function buildSiliconFlowProvider(): ModelProviderConfig {
  return {
    baseUrl: SILICONFLOW_BASE_URL,
    api: "openai-completions",
    models: SILICONFLOW_MODEL_CATALOG.map(buildSiliconFlowModelDefinition),
  };
}
