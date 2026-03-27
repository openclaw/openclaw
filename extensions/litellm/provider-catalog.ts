import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";
import { buildLitellmModelDefinition, LITELLM_BASE_URL } from "./onboard.js";

export function buildLitellmProvider(): ModelProviderConfig {
  return {
    baseUrl: LITELLM_BASE_URL,
    api: "openai-completions",
    models: [buildLitellmModelDefinition()],
  };
}
