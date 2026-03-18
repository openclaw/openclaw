import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import { applyXaiModelCompat } from "openclaw/plugin-sdk/provider-models";
import { createToolStreamWrapper } from "openclaw/plugin-sdk/provider-stream";
import { applyXaiConfig, XAI_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildXaiProvider } from "./provider-catalog.js";
import { isModernXaiModel, resolveXaiForwardCompatModel } from "./provider-models.js";
import {
  createXaiToolCallArgumentDecodingWrapper,
  createXaiToolPayloadCompatibilityWrapper,
} from "./stream.js";
import { createXaiWebSearchProvider } from "./web-search.js";

const PROVIDER_ID = "xai";

export default definePluginEntry({
  id: "xai",
  name: "xAI Plugin",
  description: "Bundled xAI plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "xAI",
      aliases: ["x-ai"],
      docsPath: "/providers/xai",
      envVars: ["XAI_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "xAI API key",
          hint: "API key",
          optionKey: "xaiApiKey",
          flagName: "--xai-api-key",
          envVar: "XAI_API_KEY",
          promptMessage: "Enter xAI API key",
          defaultModel: XAI_DEFAULT_MODEL_REF,
          expectedProviders: ["xai"],
          applyConfig: (cfg) => applyXaiConfig(cfg),
          wizard: {
            choiceId: "xai-api-key",
            choiceLabel: "xAI API key",
            groupId: "xai",
            groupLabel: "xAI (Grok)",
            groupHint: "API key",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildXaiProvider,
          }),
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
      wrapStreamFn: (ctx) =>
        createToolStreamWrapper(
          createXaiToolCallArgumentDecodingWrapper(
            createXaiToolPayloadCompatibilityWrapper(ctx.streamFn),
          ),
          ctx.extraParams?.tool_stream !== false,
        ),
      normalizeResolvedModel: ({ model }) => applyXaiModelCompat(model),
      resolveDynamicModel: (ctx) => resolveXaiForwardCompatModel({ providerId: PROVIDER_ID, ctx }),
      isModernModelRef: ({ modelId }) => isModernXaiModel(modelId),
    });
    api.registerWebSearchProvider(createXaiWebSearchProvider());
  },
});
