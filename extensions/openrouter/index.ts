import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/core";
import { DEFAULT_CONTEXT_TOKENS } from "../../src/agents/defaults.js";
import { buildOpenrouterProvider } from "../../src/agents/models-config.providers.static.js";
import {
  getOpenRouterModelCapabilities,
  loadOpenRouterModelCapabilities,
} from "../../src/agents/pi-embedded-runner/openrouter-model-capabilities.js";
import {
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "../../src/agents/pi-embedded-runner/proxy-stream-wrappers.js";

const PROVIDER_ID = "openrouter";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_CACHE_TTL_MODEL_PREFIXES = [
  "anthropic/",
  "moonshot/",
  "moonshotai/",
  "zai/",
] as const;

function buildDynamicOpenRouterModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel {
  const capabilities = getOpenRouterModelCapabilities(ctx.modelId);
  return {
    id: ctx.modelId,
    name: capabilities?.name ?? ctx.modelId,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: capabilities?.reasoning ?? false,
    input: capabilities?.input ?? ["text"],
    cost: capabilities?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: capabilities?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    maxTokens: capabilities?.maxTokens ?? OPENROUTER_DEFAULT_MAX_TOKENS,
  };
}

function injectOpenRouterRouting(
  baseStreamFn: StreamFn | undefined,
  providerRouting?: Record<string, unknown>,
): StreamFn | undefined {
  if (!providerRouting) {
    return baseStreamFn;
  }
  return (model, context, options) =>
    (
      baseStreamFn ??
      ((nextModel, nextContext, nextOptions) => {
        throw new Error(
          `OpenRouter routing wrapper requires an underlying streamFn for ${String(nextModel.id)}.`,
        );
      })
    )(
      {
        ...model,
        compat: { ...model.compat, openRouterRouting: providerRouting },
      } as typeof model,
      context,
      options,
    );
}

function isOpenRouterCacheTtlModel(modelId: string): boolean {
  return OPENROUTER_CACHE_TTL_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

const openRouterPlugin = {
  id: "openrouter",
  name: "OpenRouter Provider",
  description: "Bundled OpenRouter provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "OpenRouter",
      docsPath: "/providers/models",
      envVars: ["OPENROUTER_API_KEY"],
      auth: [],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...buildOpenrouterProvider(),
              apiKey,
            },
          };
        },
      },
      resolveDynamicModel: (ctx) => buildDynamicOpenRouterModel(ctx),
      prepareDynamicModel: async (ctx) => {
        await loadOpenRouterModelCapabilities(ctx.modelId);
      },
      capabilities: {
        openAiCompatTurnValidation: false,
        geminiThoughtSignatureSanitization: true,
        geminiThoughtSignatureModelHints: ["gemini"],
      },
      isModernModelRef: () => true,
      wrapStreamFn: (ctx) => {
        let streamFn = ctx.streamFn;
        const providerRouting =
          ctx.extraParams?.provider != null && typeof ctx.extraParams.provider === "object"
            ? (ctx.extraParams.provider as Record<string, unknown>)
            : undefined;
        if (providerRouting) {
          streamFn = injectOpenRouterRouting(streamFn, providerRouting);
        }
        const skipReasoningInjection =
          ctx.modelId === "auto" || isProxyReasoningUnsupported(ctx.modelId);
        const openRouterThinkingLevel = skipReasoningInjection ? undefined : ctx.thinkingLevel;
        streamFn = createOpenRouterWrapper(streamFn, openRouterThinkingLevel);
        streamFn = createOpenRouterSystemCacheWrapper(streamFn);
        return streamFn;
      },
      isCacheTtlEligible: (ctx) => isOpenRouterCacheTtlModel(ctx.modelId),
    });
  },
};

export default openRouterPlugin;
