import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  definePluginEntry,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
  type ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";

const PROVIDER_ID = "openrouter";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_CACHE_TTL_MODEL_PREFIXES = [
  "anthropic/",
  "moonshot/",
  "moonshotai/",
  "zai/",
] as const;

export default definePluginEntry({
  id: "openrouter",
  name: "OpenRouter Provider",
  description: "Bundled OpenRouter provider plugin",
  async register(api) {
    const {
      buildProviderReplayFamilyHooks,
      buildProviderStreamFamilyHooks,
      createProviderApiKeyAuthMethod,
      DEFAULT_CONTEXT_TOKENS,
      getOpenRouterModelCapabilities,
      loadOpenRouterModelCapabilities,
      OPENROUTER_DEFAULT_MODEL_REF,
      openrouterMediaUnderstandingProvider,
      applyOpenrouterConfig,
      buildOpenrouterProvider,
    } = await import("./register.runtime.js");
    const PASSTHROUGH_GEMINI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
      family: "passthrough-gemini",
    });
    const OPENROUTER_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("openrouter-thinking");

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

    function wrapOpenRouterProviderStream(
      ctx: ProviderWrapStreamFnContext,
    ): StreamFn | null | undefined {
      const providerRouting =
        ctx.extraParams?.provider != null && typeof ctx.extraParams.provider === "object"
          ? (ctx.extraParams.provider as Record<string, unknown>)
          : undefined;
      const routedStreamFn = providerRouting
        ? injectOpenRouterRouting(ctx.streamFn, providerRouting)
        : ctx.streamFn;
      const wrapStreamFn = OPENROUTER_THINKING_STREAM_HOOKS.wrapStreamFn ?? undefined;
      if (!wrapStreamFn) {
        return routedStreamFn;
      }
      return (
        wrapStreamFn({
          ...ctx,
          streamFn: routedStreamFn,
        }) ?? undefined
      );
    }

    function isOpenRouterCacheTtlModel(modelId: string): boolean {
      return OPENROUTER_CACHE_TTL_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
    }

    api.registerProvider({
      id: PROVIDER_ID,
      label: "OpenRouter",
      docsPath: "/providers/models",
      envVars: ["OPENROUTER_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
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
            groupLabel: "OpenRouter",
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
      ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
      resolveReasoningOutputMode: () => "native",
      isModernModelRef: () => true,
      wrapStreamFn: wrapOpenRouterProviderStream,
      isCacheTtlEligible: (ctx) => isOpenRouterCacheTtlModel(ctx.modelId),
    });
    api.registerMediaUnderstandingProvider(openrouterMediaUnderstandingProvider);
  },
});
