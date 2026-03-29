import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  definePluginEntry,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { DEFAULT_CONTEXT_TOKENS } from "openclaw/plugin-sdk/provider-model-shared";
import {
  getAllCachedOpenRouterModels,
  getOpenRouterModelCapabilities,
  loadOpenRouterModelCapabilities,
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "openclaw/plugin-sdk/provider-stream";
import { applyXaiModelCompat } from "openclaw/plugin-sdk/xai";
import { openrouterMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { applyOpenrouterConfig, OPENROUTER_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildOpenrouterProvider } from "./provider-catalog.js";

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

function isXaiOpenRouterModel(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith("x-ai/");
}

export default definePluginEntry({
  id: "openrouter",
  name: "OpenRouter Provider",
  description: "Bundled OpenRouter provider plugin",
  register(api) {
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
      capabilities: {
        openAiCompatTurnValidation: false,
        geminiThoughtSignatureSanitization: true,
        geminiThoughtSignatureModelHints: ["gemini"],
      },
      normalizeResolvedModel: ({ modelId, model }) =>
        isXaiOpenRouterModel(modelId) ? applyXaiModelCompat(model) : undefined,
      augmentModelCatalog: (ctx) => {
        // Surface cached OpenRouter model capabilities in the catalog so that
        // reasoning/thinking defaults resolve correctly for dynamic models
        // (e.g. kimi-k2.5) that aren't in the static models.json.
        const existing = new Set(
          ctx.entries.filter((e) => e.provider === PROVIDER_ID).map((e) => e.id),
        );
        const cached = getAllCachedOpenRouterModels();
        const supplemental: Array<{
          id: string;
          name: string;
          provider: string;
          reasoning: boolean;
          input: Array<"text" | "image">;
          contextWindow: number;
        }> = [];
        for (const [id, caps] of cached) {
          if (!existing.has(id)) {
            supplemental.push({
              id,
              name: caps.name,
              provider: PROVIDER_ID,
              reasoning: caps.reasoning,
              input: caps.input,
              contextWindow: caps.contextWindow,
            });
          }
        }
        return supplemental;
      },
      resolveDefaultThinkingLevel: (ctx) => {
        // Use catalog hint when available.
        if (ctx.reasoning != null) {
          return ctx.reasoning ? "low" : undefined;
        }
        // Fallback: check the OpenRouter capability cache for dynamic models
        // that are not yet in the static catalog.
        const caps = getOpenRouterModelCapabilities(ctx.modelId);
        return caps?.reasoning ? "low" : undefined;
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
    api.registerMediaUnderstandingProvider(openrouterMediaUnderstandingProvider);
  },
});
