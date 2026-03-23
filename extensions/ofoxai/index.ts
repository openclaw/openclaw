import {
  definePluginEntry,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { DEFAULT_CONTEXT_TOKENS } from "openclaw/plugin-sdk/provider-models";
import { applyOfoxaiConfig, OFOXAI_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildOfoxaiProvider } from "./provider-catalog.js";

const PROVIDER_ID = "ofoxai";
const OFOXAI_BASE_URL = "https://api.ofox.ai/v1";
const OFOXAI_DEFAULT_MAX_TOKENS = 8192;

function buildDynamicOfoxaiModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel {
  return {
    id: ctx.modelId,
    name: ctx.modelId,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: OFOXAI_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: OFOXAI_DEFAULT_MAX_TOKENS,
  };
}

export default definePluginEntry({
  id: "ofoxai",
  name: "OfoxAI Provider",
  description: "Bundled OfoxAI provider plugin — unified API gateway for 100+ LLM models",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "OfoxAI",
      docsPath: "/providers/models",
      envVars: ["OFOXAI_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "OfoxAI API key",
          hint: "API key",
          optionKey: "ofoxaiApiKey",
          flagName: "--ofoxai-api-key",
          envVar: "OFOXAI_API_KEY",
          promptMessage: "Enter OfoxAI API key",
          defaultModel: OFOXAI_DEFAULT_MODEL_REF,
          expectedProviders: ["ofoxai"],
          applyConfig: (cfg) => applyOfoxaiConfig(cfg),
          wizard: {
            choiceId: "ofoxai-api-key",
            choiceLabel: "OfoxAI API key",
            groupId: "ofoxai",
            groupLabel: "OfoxAI",
            groupHint: "API key",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...buildOfoxaiProvider(),
              apiKey,
            },
          };
        },
      },
      resolveDynamicModel: (ctx) => buildDynamicOfoxaiModel(ctx),
      isModernModelRef: () => true,
    });
  },
});
