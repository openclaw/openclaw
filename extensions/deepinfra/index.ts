import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  applyModelCompatPatch,
  buildProviderReplayFamilyHooks,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "openclaw/plugin-sdk/provider-stream";
import {
  applyAnthropicEphemeralCacheControlMarkers,
  applyCompletionsAnthropicCacheControl,
  createPayloadPatchStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { deepinfraEmbeddingProviderAdapter } from "./embedding-adapter.js";
import { buildDeepInfraImageGenerationProvider } from "./image-generation-provider.js";
import { deepinfraMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { applyDeepInfraConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildDeepInfraApiKeyCatalog } from "./provider-catalog.js";
import {
  DEEPINFRA_DEFAULT_MODEL_REF,
  buildStaticDeepInfraProvider,
} from "./provider-static-catalog.js";
import { buildDeepInfraSpeechProvider } from "./speech-provider.js";
import {
  listDeepInfraImageGenCatalog,
  listDeepInfraVideoGenCatalog,
} from "./surface-model-catalogs.js";
import { buildDeepInfraVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "deepinfra";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "DeepInfra Provider",
  description: "Bundled DeepInfra provider plugin",
  manifest,
  provider: {
    label: "DeepInfra",
    docsPath: "/providers/deepinfra",
    manifestAuth: {
      noteTitle: "DeepInfra",
      noteMessage: [
        "DeepInfra provides an OpenAI-compatible API for open source and frontier models.",
        "Get your API key at: https://deepinfra.com/dash/api_keys",
      ].join("\n"),
      defaultModel: DEEPINFRA_DEFAULT_MODEL_REF,
      applyConfig: applyDeepInfraConfig,
    },
    catalog: {
      order: "simple",
      run: buildDeepInfraApiKeyCatalog,
      staticRun: async () => ({ provider: buildStaticDeepInfraProvider() }),
    },
    ...buildProviderReplayFamilyHooks({ family: "passthrough-gemini" }),
    normalizeResolvedModel: ({ model }) =>
      model.api === "openai-completions" &&
      model.baseUrl?.trim().replace(/\/+$/u, "") ===
        manifest.modelCatalog.providers.deepinfra.baseUrl
        ? applyModelCompatPatch(model, {
            supportsPromptCacheKey: model.compat?.supportsPromptCacheKey ?? true,
            supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? false,
          })
        : model,
    wrapStreamFn: (ctx) => {
      const thinkingLevel = isProxyReasoningUnsupported(ctx.modelId)
        ? undefined
        : ctx.thinkingLevel;
      // OpenRouter wrapper handles reasoning normalization for proxy-style
      // providers; layer DeepInfra's anthropic cache-marker wrapper on top so
      // anthropic/* requests carry the ephemeral cache_control markers that
      // the upstream OpenRouter-only wrapper skips.
      const baseStreamFn = createOpenRouterWrapper(ctx.streamFn, thinkingLevel);
      const extraParams = ctx.extraParams;
      return (model, context, options) => {
        if (!model.id.toLowerCase().startsWith("anthropic/")) {
          return baseStreamFn(model, context, options);
        }
        const isCompletions = model.api === "openai-completions";
        const configured = options?.cacheRetention ?? extraParams?.cacheRetention;
        const cacheRetention =
          configured === "none" || configured === "long" ? configured : "short";
        return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload }) => {
          if (isCompletions) {
            applyCompletionsAnthropicCacheControl(
              payload,
              cacheRetention === "none" ? null : { type: "ephemeral" },
            );
          } else {
            applyAnthropicEphemeralCacheControlMarkers(payload);
          }
        })(model, context, isCompletions ? { ...options, cacheRetention } : options);
      };
    },
    isModernModelRef: () => true,
    isCacheTtlEligible: (ctx) => ctx.modelId.toLowerCase().startsWith("anthropic/"),
  },
  register(api) {
    // Registration stays offline; image/video catalog hooks refresh after auth.
    api.registerImageGenerationProvider(buildDeepInfraImageGenerationProvider());
    api.registerModelCatalogProvider({
      provider: PROVIDER_ID,
      kinds: ["image_generation"],
      liveCatalog: listDeepInfraImageGenCatalog,
    });
    api.registerMediaUnderstandingProvider(deepinfraMediaUnderstandingProvider);
    api.registerEmbeddingProvider(deepinfraEmbeddingProviderAdapter);
    api.registerSpeechProvider(buildDeepInfraSpeechProvider());
    api.registerVideoGenerationProvider(buildDeepInfraVideoGenerationProvider());
    api.registerModelCatalogProvider({
      provider: PROVIDER_ID,
      kinds: ["video_generation"],
      liveCatalog: listDeepInfraVideoGenCatalog,
    });
  },
});
