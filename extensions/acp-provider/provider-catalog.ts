import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";

const ACP_PLACEHOLDER_BASE_URL = "https://acp.local/v1";
const ACP_DEFAULT_CONTEXT_WINDOW = 200_000;
const ACP_DEFAULT_MAX_TOKENS = 16_384;
const ACP_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Build the static catalog entry for the ACP provider.
 *
 * ACP is a pass-through provider: any model id is accepted because the
 * underlying ACP agent resolves the actual model. The catalog lists a single
 * "default" entry so that `acp/default` works out of the box.
 */
export function buildAcpProvider(): ModelProviderConfig {
  return {
    baseUrl: ACP_PLACEHOLDER_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: "default",
        name: "ACP Default Agent",
        reasoning: false,
        input: ["text"],
        cost: ACP_DEFAULT_COST,
        contextWindow: ACP_DEFAULT_CONTEXT_WINDOW,
        maxTokens: ACP_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}
