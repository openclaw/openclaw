import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  definePluginEntry,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
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

/**
 * Injects the OpenRouter auto-router plugin into the request payload,
 * constraining model selection to the provided allowlist.
 *
 * Config example:
 * ```json
 * {
 *   "model": "openrouter/openrouter/auto",
 *   "params": {
 *     "autoRouter": { "allowedModels": ["anthropic/claude-haiku-4-5", "google/gemini-2.5-flash"] }
 *   }
 * }
 * ```
 */
export function injectAutoRouterPlugin(
  baseStreamFn: StreamFn | undefined,
  allowedModels: string[],
): StreamFn {
  const underlying =
    baseStreamFn ??
    ((nextModel: { id?: unknown }) => {
      throw new Error(
        `OpenRouter auto-router wrapper requires an underlying streamFn for ${String(nextModel.id)}.`,
      );
    });
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return (underlying as StreamFn)(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const existing = Array.isArray((payload as Record<string, unknown>).plugins)
            ? ((payload as Record<string, unknown>).plugins as unknown[])
            : [];
          (payload as Record<string, unknown>).plugins = [
            ...existing,
            { id: "auto-router", allowed_models: allowedModels },
          ];
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

/**
 * Returns true if the pattern is or contains an x-ai model reference, including wildcards
 * such as `x-ai/*`. Note: provider-agnostic wildcards like `*\/grok-*` cannot be detected
 * without a model registry lookup and are not handled here.
 */
function patternMightBeProxyReasoningUnsupported(pattern: string): boolean {
  const lower = pattern.trim().toLowerCase();
  return lower.startsWith("x-ai/") || lower.includes("/x-ai/");
}

export default definePluginEntry({
  id: "openrouter",
  name: "OpenRouter Provider",
  description: "Bundled OpenRouter provider plugin",
  async register(api) {
    const {
      buildPassthroughGeminiSanitizingReplayPolicy,
      composeProviderStreamWrappers,
      createOpenRouterSystemCacheWrapper,
      createOpenRouterWrapper,
      createProviderApiKeyAuthMethod,
      DEFAULT_CONTEXT_TOKENS,
      getOpenRouterModelCapabilities,
      isProxyReasoningUnsupported,
      loadOpenRouterModelCapabilities,
      OPENROUTER_DEFAULT_MODEL_REF,
      openrouterMediaUnderstandingProvider,
      applyOpenrouterConfig,
      buildOpenrouterProvider,
    } = await import("./register.runtime.js");

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
      buildReplayPolicy: ({ modelId }) => buildPassthroughGeminiSanitizingReplayPolicy(modelId),
      resolveReasoningOutputMode: () => "native",
      isModernModelRef: () => true,
      wrapStreamFn: (ctx) => {
        const providerRouting =
          ctx.extraParams?.provider != null && typeof ctx.extraParams.provider === "object"
            ? (ctx.extraParams.provider as Record<string, unknown>)
            : undefined;
        let autoRouterAllowedModels: string[] = [];
        const autoRouterConfig = ctx.extraParams?.autoRouter;
        if (autoRouterConfig != null && typeof autoRouterConfig === "object") {
          const rawAllowedModels = (autoRouterConfig as Record<string, unknown>).allowedModels;
          if (Array.isArray(rawAllowedModels) && rawAllowedModels.length > 0) {
            const validModels = rawAllowedModels.filter((m): m is string => typeof m === "string");
            if (validModels.length > 0) {
              autoRouterAllowedModels = validModels;
            }
          }
        }
        // Skip reasoning injection if the model ID itself is unsupported, or if the
        // autoRouter allowlist contains x-ai models (proxy reasoning unsupported via OpenRouter).
        const allowlistBlocksReasoning = autoRouterAllowedModels.some(
          patternMightBeProxyReasoningUnsupported,
        );
        if (allowlistBlocksReasoning && ctx.thinkingLevel && ctx.thinkingLevel !== "off") {
          api.logger.warn?.(
            `openrouter: reasoning injection suppressed because autoRouter.allowedModels contains x-ai models that do not support proxy reasoning (thinkingLevel=${ctx.thinkingLevel}). Remove x-ai models from the allowlist to enable reasoning.`,
          );
        }
        const skipReasoningInjection =
          ctx.modelId === "auto" ||
          isProxyReasoningUnsupported(ctx.modelId) ||
          allowlistBlocksReasoning;
        const openRouterThinkingLevel = skipReasoningInjection ? undefined : ctx.thinkingLevel;
        return composeProviderStreamWrappers(
          ctx.streamFn,
          providerRouting
            ? (streamFn) => injectOpenRouterRouting(streamFn, providerRouting)
            : undefined,
          autoRouterAllowedModels.length > 0
            ? (streamFn) => injectAutoRouterPlugin(streamFn, autoRouterAllowedModels)
            : undefined,
          (streamFn) => createOpenRouterWrapper(streamFn, openRouterThinkingLevel),
          (streamFn) => createOpenRouterSystemCacheWrapper(streamFn),
        );
      },
      isCacheTtlEligible: (ctx) => isOpenRouterCacheTtlModel(ctx.modelId),
    });
    api.registerMediaUnderstandingProvider(openrouterMediaUnderstandingProvider);
  },
});
