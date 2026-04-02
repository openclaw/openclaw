import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildChuiziModelDefinition, CHUIZI_BASE_URL, CHUIZI_MODEL_CATALOG } from "./api.js";

export function buildChuiziProvider(): ModelProviderConfig {
  return {
    baseUrl: CHUIZI_BASE_URL,
    api: "openai-completions",
    models: CHUIZI_MODEL_CATALOG.map(buildChuiziModelDefinition),
  };
}
