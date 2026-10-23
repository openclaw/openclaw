import { calculateCost, streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderResolveDynamicModelContext } from "openclaw/plugin-sdk/plugin-entry";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  applyModelCompatPatch,
  buildProviderReplayFamilyHooks,
  normalizeProviderId,
  resolveFamilyForwardCompatModel,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  createPayloadPatchStreamWrapper,
  transformProviderStreamMessages,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { isFireworksKimiModelId } from "./model-id.js";
import { applyFireworksConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  FIREWORKS_BASE_URL,
  FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  FIREWORKS_DEFAULT_MAX_TOKENS,
  FIREWORKS_DEFAULT_MODEL_ID,
  isFireworksCatalogModelId,
  isFireworksNativeModel,
} from "./provider-catalog.js";
import { resolveFireworksThinkingProfile } from "./thinking-policy.js";

const PROVIDER_ID = "fireworks";

function isFireworksProviderId(providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  return normalized === "fireworks" || normalized === "fireworks-ai";
}

function isFireworksGlmModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  const lastSegment = normalized.split("/").pop() ?? normalized;
  return /^glm[-_.]/.test(lastSegment);
}

function resolveFireworksDynamicModel(ctx: ProviderResolveDynamicModelContext) {
  const modelId = ctx.modelId.trim();
  if (!modelId || isFireworksCatalogModelId(modelId)) {
    return undefined;
  }

  return resolveFamilyForwardCompatModel({
    providerId: PROVIDER_ID,
    modelId,
    ctx,
    cases: [
      {
        match: () => true,
        templateIds: [FIREWORKS_DEFAULT_MODEL_ID],
        patch: ({ template }) =>
          template
            ? undefined
            : {
                api: "openai-completions",
                baseUrl: FIREWORKS_BASE_URL,
                contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
                maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
              },
      },
    ],
    patch: {
      provider: PROVIDER_ID,
      reasoning: !isFireworksKimiModelId(modelId),
      input: isFireworksGlmModelId(modelId) ? ["text"] : ["text", "image"],
    },
    synthesize: true,
  });
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Fireworks Provider",
  description: "Bundled Fireworks AI provider plugin",
  manifest,
  provider: {
    label: "Fireworks",
    aliases: ["fireworks-ai"],
    docsPath: "/providers/fireworks",
    manifestAuth: { applyConfig: applyFireworksConfig },
    catalog: {
      discoveryMode: "strict",
      allowExplicitBaseUrl: true,
      liveModelDiscovery: true,
    },
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
    normalizeResolvedModel: ({ model }) =>
      isFireworksNativeModel(model)
        ? applyModelCompatPatch(model, {
            supportsPromptCacheKey: model.compat?.supportsPromptCacheKey ?? true,
            supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? false,
          })
        : model,
    wrapStreamFn(ctx) {
      if (
        !isFireworksProviderId(ctx.provider) ||
        (ctx.sourceApi ?? ctx.model?.api) !== "openai-completions"
      ) {
        return undefined;
      }
      const isKimi = isFireworksKimiModelId(ctx.modelId);
      const isNative = isFireworksNativeModel(ctx.model, ctx.sourceApi);
      if (!isKimi && !isNative) {
        return undefined;
      }
      const underlying = isKimi
        ? createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload }) => {
            // Fireworks Kimi can emit chain-of-thought in visible `content` unless
            // the Anthropic-style thinking toggle is explicitly disabled.
            payload.thinking = { type: "disabled" };
            delete payload.reasoning;
            delete payload.reasoning_effort;
            delete payload.reasoningEffort;
          })
        : (ctx.streamFn ?? streamSimple);
      if (!isNative) {
        return underlying;
      }
      return async (model, context, options) => {
        let cache: { prompt: number; read: number } | undefined;
        const stream = await underlying(model, context, {
          ...options,
          onResponse(response, responseModel) {
            const prompt = Number(
              response.headers["fireworks-prompt-tokens"]?.trim() || Number.NaN,
            );
            const read = Number(
              response.headers["fireworks-cached-prompt-tokens"]?.trim() || Number.NaN,
            );
            cache =
              Number.isSafeInteger(prompt) &&
              Number.isSafeInteger(read) &&
              read >= 0 &&
              read <= prompt
                ? { prompt, read }
                : undefined;
            return options?.onResponse?.(response, responseModel);
          },
        });
        return transformProviderStreamMessages(stream, (message) => {
          const usage = message.usage;
          if (
            !cache ||
            usage.cacheTelemetry?.state !== "unavailable" ||
            usage.input + usage.cacheRead + usage.cacheWrite !== cache.prompt
          ) {
            return;
          }
          usage.input -= cache.read;
          usage.cacheRead = cache.read;
          usage.cacheTelemetry = { state: "available" };
          const billedTotal = usage.cost.total;
          calculateCost(model, usage);
          if (usage.cost.totalOrigin === "provider-billed") {
            usage.cost.total = billedTotal;
          }
        });
      };
    },
    resolveThinkingProfile: ({ modelId }) => resolveFireworksThinkingProfile(modelId),
    resolveDynamicModel: resolveFireworksDynamicModel,
    isModernModelRef: () => true,
  },
});
