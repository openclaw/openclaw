// OmniRoute model metadata for the thin OpenAI-compatible provider wrapper.
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const OMNIROUTE_PROVIDER_ID = "omniroute";
export const OMNIROUTE_LABEL = "OmniRoute";
export const OMNIROUTE_API_KEY_ENV_VAR = "OMNIROUTE_API_KEY";
export const OMNIROUTE_DEFAULT_BASE_URL = "http://localhost:20128/v1";
export const OMNIROUTE_DEFAULT_MODEL_ID = "auto";
export const OMNIROUTE_DEFAULT_MODEL_REF = `${OMNIROUTE_PROVIDER_ID}/${OMNIROUTE_DEFAULT_MODEL_ID}`;

export function buildOmniRouteDefaultModel(): ModelDefinitionConfig {
  return {
    id: OMNIROUTE_DEFAULT_MODEL_ID,
    name: "Auto (OmniRoute)",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: {
      supportsUsageInStreaming: true,
    },
  };
}
