import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "openclaw/plugin-sdk/provider-stream";
import { createDeepInfraAnthropicCacheWrapper } from "./cache-wrapper.js";
import { buildDeepInfraEmbeddingAdapter } from "./embedding-adapter.js";
import { buildDeepInfraImageGenerationProvider } from "./image-generation-provider.js";
import { buildDeepInfraMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { applyDeepInfraConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildDeepInfraApiKeyCatalog } from "./provider-catalog.js";
import { getDeepInfraSurfaceFallbackCatalog } from "./provider-models.js";
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
    normalizeConfig: ({ providerConfig }) => providerConfig,
    normalizeTransport: ({ api, baseUrl }) =>
      baseUrl === "https://api.deepinfra.com/v1/openai" ? { api, baseUrl } : undefined,
    ...buildProviderReplayFamilyHooks({ family: "passthrough-gemini" }),
    wrapStreamFn: (ctx) => {
      const thinkingLevel = isProxyReasoningUnsupported(ctx.modelId)
        ? undefined
        : ctx.thinkingLevel;
      // OpenRouter wrapper handles reasoning normalization for proxy-style
      // providers; layer DeepInfra's anthropic cache-marker wrapper on top so
      // anthropic/* requests carry the ephemeral cache_control markers that
      // the upstream OpenRouter-only wrapper skips.
      return createDeepInfraAnthropicCacheWrapper(
        createOpenRouterWrapper(ctx.streamFn, thinkingLevel),
        ctx.extraParams,
      );
    },
    isModernModelRef: () => true,
    isCacheTtlEligible: (ctx) => ctx.modelId.toLowerCase().startsWith("anthropic/"),
  },
  register(api) {
    // Registration stays offline; image/video catalog hooks refresh after auth.
    const catalog = getDeepInfraSurfaceFallbackCatalog();
    api.registerImageGenerationProvider(
      buildDeepInfraImageGenerationProvider({ imageGenModels: catalog.imageGen }),
    );
    api.registerModelCatalogProvider({
      provider: PROVIDER_ID,
      kinds: ["image_generation"],
      liveCatalog: listDeepInfraImageGenCatalog,
    });
    api.registerMediaUnderstandingProvider(
      buildDeepInfraMediaUnderstandingProvider({
        vlmModels: catalog.vlm,
        sttModels: catalog.stt,
      }),
    );
    api.registerEmbeddingProvider(buildDeepInfraEmbeddingAdapter({ embedModels: catalog.embed }));
    api.registerSpeechProvider(buildDeepInfraSpeechProvider({ ttsModels: catalog.tts }));
    api.registerVideoGenerationProvider(
      buildDeepInfraVideoGenerationProvider({ videoGenModels: catalog.videoGen }),
    );
    api.registerModelCatalogProvider({
      provider: PROVIDER_ID,
      kinds: ["video_generation"],
      liveCatalog: listDeepInfraVideoGenCatalog,
    });
  },
});
