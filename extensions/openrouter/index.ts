import {
  definePluginEntry,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  DEFAULT_CONTEXT_TOKENS,
  PASSTHROUGH_GEMINI_REPLAY_HOOKS,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  getOpenRouterModelCapabilities,
  loadOpenRouterModelCapabilities,
} from "openclaw/plugin-sdk/provider-stream-family";
import { buildOpenRouterImageGenerationProvider } from "./image-generation-provider.js";
import { openrouterMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildOpenRouterMusicGenerationProvider } from "./music-generation-provider.js";
import {
  applyOpenrouterConfig,
  applyTrustedRouterConfig,
  OPENROUTER_DEFAULT_MODEL_REF,
  TRUSTEDROUTER_DEFAULT_MODEL_REF,
} from "./onboard.js";
import {
  buildOpenrouterProvider,
  buildTrustedRouterProvider,
  isOpenRouterProxyReasoningUnsupportedModel,
  normalizeOpenRouterBaseUrl,
  normalizeTrustedRouterBaseUrl,
  OPENROUTER_BASE_URL,
  TRUSTEDROUTER_BASE_URL,
} from "./provider-catalog.js";
import { buildOpenRouterSpeechProvider } from "./speech-provider.js";
import { wrapOpenRouterProviderStream } from "./stream.js";
import {
  resolveOpenRouterThinkingProfile,
  supportsOpenRouterXHighThinking,
} from "./thinking-policy.js";
import {
  buildOpenRouterVideoGenerationProvider,
  listOpenRouterVideoModelCatalog,
} from "./video-generation-provider.js";

const OPENROUTER_PROVIDER_ID = "openrouter";
const TRUSTEDROUTER_PROVIDER_ID = "trustedrouter";
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_CACHE_TTL_MODEL_PREFIXES = [
  "anthropic/",
  "deepseek/",
  "moonshot/",
  "moonshotai/",
  "zai/",
] as const;

function normalizeOpenRouterResolvedModel<T extends ProviderRuntimeModel>(model: T): T | undefined {
  const normalizedBaseUrl = normalizeOpenRouterBaseUrl(model.baseUrl);
  const reasoning = isOpenRouterProxyReasoningUnsupportedModel(model.id) ? false : model.reasoning;
  if (
    (!normalizedBaseUrl || normalizedBaseUrl === model.baseUrl) &&
    reasoning === model.reasoning
  ) {
    return undefined;
  }
  return {
    ...model,
    ...(normalizedBaseUrl ? { baseUrl: normalizedBaseUrl } : {}),
    reasoning,
  };
}

function normalizeTrustedRouterResolvedModel<T extends ProviderRuntimeModel>(
  model: T,
): T | undefined {
  const normalizedBaseUrl = normalizeTrustedRouterBaseUrl(model.baseUrl);
  const reasoning = isOpenRouterProxyReasoningUnsupportedModel(model.id) ? false : model.reasoning;
  if (
    (!normalizedBaseUrl || normalizedBaseUrl === model.baseUrl) &&
    reasoning === model.reasoning
  ) {
    return undefined;
  }
  return {
    ...model,
    ...(normalizedBaseUrl ? { baseUrl: normalizedBaseUrl } : {}),
    reasoning,
  };
}

export default definePluginEntry({
  id: "openrouter",
  name: "OpenRouter Provider",
  description: "Bundled OpenRouter provider plugin",
  register(api) {
    function buildDynamicOpenRouterModel(
      ctx: ProviderResolveDynamicModelContext,
      providerId = OPENROUTER_PROVIDER_ID,
      baseUrl = OPENROUTER_BASE_URL,
    ): ProviderRuntimeModel {
      const capabilities = getOpenRouterModelCapabilities(ctx.modelId);
      return {
        id: ctx.modelId,
        name: capabilities?.name ?? ctx.modelId,
        api: "openai-completions",
        provider: providerId,
        baseUrl,
        reasoning:
          (capabilities?.reasoning ?? false) &&
          !isOpenRouterProxyReasoningUnsupportedModel(ctx.modelId),
        input: capabilities?.input ?? ["text"],
        ...(capabilities?.supportsTools !== undefined
          ? { compat: { supportsTools: capabilities.supportsTools } }
          : {}),
        cost: capabilities?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: capabilities?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
        maxTokens: capabilities?.maxTokens ?? OPENROUTER_DEFAULT_MAX_TOKENS,
      };
    }

    function isOpenRouterCacheTtlModel(modelId: string): boolean {
      return OPENROUTER_CACHE_TTL_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
    }

    api.registerProvider({
      id: OPENROUTER_PROVIDER_ID,
      label: "OpenRouter",
      docsPath: "/providers/models",
      envVars: ["OPENROUTER_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: OPENROUTER_PROVIDER_ID,
          methodId: "api-key",
          label: "OpenRouter API key",
          hint: "API key",
          optionKey: "openrouterApiKey",
          flagName: "--openrouter-api-key",
          envVar: "OPENROUTER_API_KEY",
          promptMessage: "Enter OpenRouter API key",
          defaultModel: OPENROUTER_DEFAULT_MODEL_REF,
          expectedProviders: ["openrouter"],
          applyConfig: (cfg) => applyOpenrouterConfig(cfg),
          wizard: {
            choiceId: "openrouter-api-key",
            choiceLabel: "OpenRouter API key",
            groupId: "openrouter",
            groupLabel: "OpenRouter-compatible routers",
            groupHint: "API key",
            onboardingScopes: ["text-inference", "music-generation"],
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(OPENROUTER_PROVIDER_ID).apiKey;
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
      staticCatalog: {
        order: "simple",
        run: async () => ({
          provider: buildOpenrouterProvider(),
        }),
      },
      resolveDynamicModel: (ctx) => buildDynamicOpenRouterModel(ctx),
      prepareDynamicModel: async (ctx) => {
        await loadOpenRouterModelCapabilities(ctx.modelId);
      },
      normalizeConfig: ({ providerConfig }) => {
        const normalizedBaseUrl = normalizeOpenRouterBaseUrl(providerConfig.baseUrl);
        return normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl
          ? { ...providerConfig, baseUrl: normalizedBaseUrl }
          : undefined;
      },
      normalizeResolvedModel: ({ model }) => normalizeOpenRouterResolvedModel(model),
      normalizeTransport: ({ api, baseUrl }) => {
        const normalizedBaseUrl = normalizeOpenRouterBaseUrl(baseUrl);
        return normalizedBaseUrl && normalizedBaseUrl !== baseUrl
          ? {
              api,
              baseUrl: normalizedBaseUrl,
            }
          : undefined;
      },
      ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
      resolveReasoningOutputMode: () => "native",
      supportsXHighThinking: ({ modelId }) => supportsOpenRouterXHighThinking(modelId),
      resolveThinkingProfile: ({ modelId }) => resolveOpenRouterThinkingProfile(modelId),
      isModernModelRef: () => true,
      wrapStreamFn: wrapOpenRouterProviderStream,
      isCacheTtlEligible: (ctx) => isOpenRouterCacheTtlModel(ctx.modelId),
    });
    api.registerProvider({
      id: TRUSTEDROUTER_PROVIDER_ID,
      label: "TrustedRouter.com",
      docsPath: "/providers/trustedrouter",
      envVars: ["TRUSTEDROUTER_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: TRUSTEDROUTER_PROVIDER_ID,
          methodId: "api-key",
          label: "TrustedRouter.com API key",
          hint: "E2EE OpenRouter-compatible API key",
          optionKey: "trustedrouterApiKey",
          flagName: "--trustedrouter-api-key",
          envVar: "TRUSTEDROUTER_API_KEY",
          promptMessage: "Enter TrustedRouter.com API key",
          defaultModel: TRUSTEDROUTER_DEFAULT_MODEL_REF,
          expectedProviders: ["trustedrouter"],
          applyConfig: (cfg) => applyTrustedRouterConfig(cfg),
          wizard: {
            choiceId: "trustedrouter-api-key",
            choiceLabel: "TrustedRouter.com API key",
            choiceHint: "End-to-end encrypted OpenRouter-compatible router",
            groupId: "openrouter",
            groupLabel: "OpenRouter-compatible routers",
            groupHint: "API key",
            onboardingScopes: ["text-inference"],
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(TRUSTEDROUTER_PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...buildTrustedRouterProvider(),
              apiKey,
            },
          };
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({
          provider: buildTrustedRouterProvider(),
        }),
      },
      resolveDynamicModel: (ctx) =>
        buildDynamicOpenRouterModel(ctx, TRUSTEDROUTER_PROVIDER_ID, TRUSTEDROUTER_BASE_URL),
      prepareDynamicModel: async (ctx) => {
        if (ctx.modelId !== TRUSTEDROUTER_DEFAULT_MODEL_REF) {
          await loadOpenRouterModelCapabilities(ctx.modelId);
        }
      },
      normalizeConfig: ({ providerConfig }) => {
        const normalizedBaseUrl = normalizeTrustedRouterBaseUrl(providerConfig.baseUrl);
        return normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl
          ? { ...providerConfig, baseUrl: normalizedBaseUrl }
          : undefined;
      },
      normalizeResolvedModel: ({ model }) => normalizeTrustedRouterResolvedModel(model),
      normalizeTransport: ({ api, baseUrl }) => {
        const normalizedBaseUrl = normalizeTrustedRouterBaseUrl(baseUrl);
        return normalizedBaseUrl && normalizedBaseUrl !== baseUrl
          ? {
              api,
              baseUrl: normalizedBaseUrl,
            }
          : undefined;
      },
      ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
      resolveReasoningOutputMode: () => "native",
      supportsXHighThinking: ({ modelId }) => supportsOpenRouterXHighThinking(modelId),
      resolveThinkingProfile: ({ modelId }) => resolveOpenRouterThinkingProfile(modelId),
      isModernModelRef: () => true,
      wrapStreamFn: wrapOpenRouterProviderStream,
    });
    api.registerMediaUnderstandingProvider(openrouterMediaUnderstandingProvider);
    api.registerImageGenerationProvider(buildOpenRouterImageGenerationProvider());
    api.registerMusicGenerationProvider(buildOpenRouterMusicGenerationProvider());
    api.registerVideoGenerationProvider(buildOpenRouterVideoGenerationProvider());
    api.registerModelCatalogProvider({
      provider: OPENROUTER_PROVIDER_ID,
      kinds: ["video_generation"],
      liveCatalog: listOpenRouterVideoModelCatalog,
    });
    api.registerSpeechProvider(buildOpenRouterSpeechProvider());
  },
});
