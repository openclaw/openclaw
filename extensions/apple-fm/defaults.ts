import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import type { AppleFmFacts } from "./native.js";

export const APPLE_FM_PROVIDER_ID = "apple-fm";
const APPLE_FM_MODEL_ID = "system";
export const APPLE_FM_MODEL_REF = `${APPLE_FM_PROVIDER_ID}/${APPLE_FM_MODEL_ID}`;
export const APPLE_FM_LOCAL_AUTH_MARKER = "apple-fm-local";
export const APPLE_FM_MIN_CONTEXT_WINDOW = 8_192;

export function buildAppleFmProviderConfig(facts: AppleFmFacts): ModelProviderConfig {
  return {
    // The shared model config requires an endpoint; native inference never sends HTTP.
    baseUrl: "http://127.0.0.1",
    api: "openai-completions",
    authHeader: false,
    timeoutSeconds: 120,
    models: [
      {
        id: APPLE_FM_MODEL_ID,
        name: facts.modelName,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: facts.contextWindow,
        maxTokens: 1_024,
        compat: {
          supportsTools: true,
          supportsJsonSchemaResponseFormat: true,
          supportsDeveloperRole: false,
          supportsUsageInStreaming: true,
        },
      },
    ],
  };
}
