import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { createToolStreamWrapper } from "openclaw/plugin-sdk/provider-stream";
import { applyXaiModelCompat, buildXaiProvider, normalizeXaiModelId } from "./api.js";
import { applyXaiConfig, XAI_DEFAULT_MODEL_REF } from "./onboard.js";
import { isModernXaiModel, resolveXaiForwardCompatModel } from "./provider-models.js";
import { createGrokWebSearchProvider } from "./src/grok-web-search-provider.js";
import {
  createXaiFastModeWrapper,
  createXaiToolCallArgumentDecodingWrapper,
  createXaiToolPayloadCompatibilityWrapper,
} from "./stream.js";

const PROVIDER_ID = "xai";

export default defineSingleProviderPluginEntry({
  id: "xai",
  name: "xAI Plugin",
  description: "Bundled xAI plugin",
  provider: {
    label: "xAI",
    aliases: ["x-ai"],
    docsPath: "/providers/xai",
    auth: [
      {
        methodId: "api-key",
        label: "xAI API key",
        hint: "API key",
        optionKey: "xaiApiKey",
        flagName: "--xai-api-key",
        envVar: "XAI_API_KEY",
        promptMessage: "Enter xAI API key",
        defaultModel: XAI_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyXaiConfig(cfg),
        wizard: {
          groupLabel: "xAI (Grok)",
        },
      },
    ],
    catalog: {
      buildProvider: buildXaiProvider,
    },
    prepareExtraParams: (ctx) => {
      if (ctx.extraParams?.tool_stream !== undefined) {
        return ctx.extraParams;
      }
      return {
        ...ctx.extraParams,
        tool_stream: true,
      };
    },
    wrapStreamFn: (ctx) => {
      let streamFn = createXaiToolPayloadCompatibilityWrapper(ctx.streamFn);
      if (typeof ctx.extraParams?.fastMode === "boolean") {
        streamFn = createXaiFastModeWrapper(streamFn, ctx.extraParams.fastMode);
      }
      streamFn = createXaiToolCallArgumentDecodingWrapper(streamFn);
      return createToolStreamWrapper(streamFn, ctx.extraParams?.tool_stream !== false);
    },
    normalizeResolvedModel: ({ model }) => applyXaiModelCompat(model),
    normalizeModelId: ({ modelId }) => normalizeXaiModelId(modelId),
    resolveDynamicModel: (ctx) => resolveXaiForwardCompatModel({ providerId: PROVIDER_ID, ctx }),
    isModernModelRef: ({ modelId }) => isModernXaiModel(modelId),
  },
  register(api) {
    api.registerWebSearchProvider(createGrokWebSearchProvider());
  },
});
