import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";

const AMAZON_NOVA_BASE_URL = "https://api.nova.amazon.com/v1";
export const AMAZON_NOVA_DEFAULT_MODEL_ID = "nova-2-lite-v1";
const AMAZON_NOVA_DEFAULT_CONTEXT_WINDOW = 1000000;
const AMAZON_NOVA_DEFAULT_MAX_TOKENS = 65535;
const AMAZON_NOVA_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const AMAZON_NOVA_HEADERS = { "Accept-Encoding": "identity" } as const;

export function buildAmazonNovaProvider(): ModelProviderConfig {
  return {
    baseUrl: AMAZON_NOVA_BASE_URL,
    api: "openai-completions",
    headers: AMAZON_NOVA_HEADERS,
    models: [
      {
        id: "nova-2-lite-v1",
        name: "Amazon Nova 2 Lite",
        reasoning: true,
        input: ["text", "image"],
        cost: AMAZON_NOVA_DEFAULT_COST,
        contextWindow: AMAZON_NOVA_DEFAULT_CONTEXT_WINDOW,
        maxTokens: AMAZON_NOVA_DEFAULT_MAX_TOKENS,
        compat: {
          supportsReasoningEffort: true,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
        },
      },
      {
        id: "nova-2-pro-v1",
        name: "Amazon Nova 2 Pro",
        reasoning: true,
        input: ["text", "image"],
        cost: AMAZON_NOVA_DEFAULT_COST,
        contextWindow: AMAZON_NOVA_DEFAULT_CONTEXT_WINDOW,
        maxTokens: AMAZON_NOVA_DEFAULT_MAX_TOKENS,
        compat: {
          supportsReasoningEffort: true,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
        },
      },
    ],
  };
}
