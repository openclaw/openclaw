import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";
import { buildDeepSeekModelDefinition, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL_CATALOG } from "./api.js";

export function buildDeepSeekProvider(): ModelProviderConfig {
  return {
    baseUrl: DEEPSEEK_BASE_URL,
    api: "openai-completions",
    models: DEEPSEEK_MODEL_CATALOG.map(buildDeepSeekModelDefinition),
  };
}
