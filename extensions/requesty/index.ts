import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  definePluginEntry,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { DEFAULT_CONTEXT_TOKENS } from "openclaw/plugin-sdk/provider-models";
import {
  createRequestySystemCacheWrapper,
  createRequestyWrapper,
  isProxyReasoningUnsupported,
} from "openclaw/plugin-sdk/provider-stream";
import { applyRequestyConfig, REQUESTY_DEFAULT_MODEL_REF } from "./onboard.js";

const PROVIDER_ID = "requesty";
const REQUESTY_BASE_URL = "https://router.requesty.ai/v1";
const REQUESTY_DEFAULT_MAX_TOKENS = 8192;
const REQUESTY_CACHE_TTL_MODEL_PREFIXES = ["anthropic/"] as const;

function buildDynamicRequestyModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel {
  return {
    id: ctx.modelId,
    name: ctx.modelId,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: REQUESTY_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: REQUESTY_DEFAULT_MAX_TOKENS,
  };
}

function isRequestyCacheTtlModel(modelId: string): boolean {
  return REQUESTY_CACHE_TTL_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

export default definePluginEntry({
  id: "requesty",
  name: "Requesty Provider",
  description: "Bundled Requesty provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Requesty",
      docsPath: "/providers/models",
      envVars: ["REQUESTY_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Requesty API key",
          hint: "API key",
          optionKey: "requestyApiKey",
          flagName: "--requesty-api-key",
          envVar: "REQUESTY_API_KEY",
          promptMessage: "Enter Requesty API key",
          defaultModel: REQUESTY_DEFAULT_MODEL_REF,
          expectedProviders: ["requesty"],
          applyConfig: (cfg) => applyRequestyConfig(cfg),
          wizard: {
            choiceId: "requesty-api-key",
            choiceLabel: "Requesty API key",
            groupId: "requesty",
            groupLabel: "Requesty",
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
              baseUrl: REQUESTY_BASE_URL,
              api: "openai-completions" as const,
              apiKey,
              models: [],
            },
          };
        },
      },
      resolveDynamicModel: (ctx) => buildDynamicRequestyModel(ctx),
      capabilities: {
        openAiCompatTurnValidation: false,
        geminiThoughtSignatureSanitization: true,
        geminiThoughtSignatureModelHints: ["gemini"],
      },
      isModernModelRef: () => true,
      wrapStreamFn: (ctx) => {
        let streamFn: StreamFn | undefined = ctx.streamFn;
        const skipReasoningInjection = isProxyReasoningUnsupported(ctx.modelId);
        const thinkingLevel = skipReasoningInjection ? undefined : ctx.thinkingLevel;
        streamFn = createRequestyWrapper(streamFn, thinkingLevel);
        streamFn = createRequestySystemCacheWrapper(streamFn);
        return streamFn;
      },
      isCacheTtlEligible: (ctx) => isRequestyCacheTtlModel(ctx.modelId),
    });
  },
});
