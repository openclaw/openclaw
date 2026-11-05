import { describeOpenAiCompatibleVideo } from "openclaw/plugin-sdk/media-understanding";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildOpenAICompatibleReplayPolicy } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createDefaultModelsPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { wrapMoonshotStream } from "./native-video.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildMoonshotProvider,
  MOONSHOT_BASE_URL,
  MOONSHOT_CN_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_ID,
  MOONSHOT_DEFAULT_MODEL_REF,
} from "./provider-catalog.js";
import {
  isMoonshotAlwaysThinkingModelId,
  isMoonshotK3NativeVideoRoute,
  resolveThinkingProfile,
} from "./provider-policy-api.js";
import { createKimiWebSearchProvider } from "./src/kimi-web-search-provider.js";

const moonshotPresetAppliers = createDefaultModelsPresetAppliers<[string]>({
  primaryModelRef: MOONSHOT_DEFAULT_MODEL_REF,
  resolveParams: (cfg: OpenClawConfig, baseUrl: string) => {
    const defaultModel = buildMoonshotProvider().models.find(
      ({ id }) => id === MOONSHOT_DEFAULT_MODEL_ID,
    );
    return defaultModel
      ? {
          providerId: "moonshot",
          api: "openai-completions",
          baseUrl,
          defaultModels: cfg.models?.mode === "replace" ? [defaultModel] : [],
          defaultModelId: MOONSHOT_DEFAULT_MODEL_ID,
          aliases: [{ modelRef: MOONSHOT_DEFAULT_MODEL_REF, alias: "Kimi" }],
        }
      : null;
  },
});

const PROVIDER_ID = "moonshot";
export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Moonshot Provider",
  description: "Bundled Moonshot provider plugin",
  manifest,
  provider: {
    label: "Moonshot",
    docsPath: "/providers/moonshot",
    aliases: ["moonshotai", "moonshot-ai"],
    manifestAuth: {
      applyConfig: (cfg) => moonshotPresetAppliers.applyConfig(cfg, MOONSHOT_BASE_URL),
    },
    extraAuth: [
      createProviderApiKeyAuthMethod({
        providerId: PROVIDER_ID,
        methodId: "api-key-cn",
        label: "Kimi API key (.cn)",
        hint: "Kimi API models · https://platform.kimi.ai/docs/pricing/chat",
        optionKey: "moonshotApiKey",
        flagName: "--moonshot-api-key",
        envVar: "MOONSHOT_API_KEY",
        promptMessage: "Enter Moonshot API key (.cn)",
        defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => moonshotPresetAppliers.applyConfig(cfg, MOONSHOT_CN_BASE_URL),
        wizard: { groupLabel: "Moonshot AI (Kimi)" },
      }),
    ],
    catalog: {
      discoveryMode: "strict",
      buildProvider: buildMoonshotProvider,
      buildStaticProvider: buildMoonshotProvider,
      allowExplicitBaseUrl: true,
      liveModelDiscovery: true,
    },
    normalizeResolvedModel: (ctx) =>
      ({
        ...ctx.model,
        input: (ctx.model.input as string[])
          .filter((type) => type !== "video")
          .concat(
            isMoonshotK3NativeVideoRoute({
              ...ctx.model,
              provider: ctx.provider,
              modelId: ctx.modelId,
            })
              ? "video"
              : [],
          ),
      }) as typeof ctx.model,
    buildReplayPolicy: ({ modelApi, modelId }) =>
      buildOpenAICompatibleReplayPolicy(modelApi, {
        modelId,
        sanitizeToolCallIds: modelApi === "openai-completions",
        duplicateToolCallIdStyle: "openai",
        dropReasoningFromHistory: false,
      }),
    wrapStreamFn: wrapMoonshotStream,
    wrapSimpleCompletionStreamFn: (ctx) => wrapMoonshotStream(ctx, true),
    resolveThinkingProfile,
    isModernModelRef: ({ modelId }) => isMoonshotAlwaysThinkingModelId(modelId),
  },
  register(api) {
    api.registerMediaUnderstandingProvider({
      id: "moonshot",
      capabilities: ["image", "video"],
      defaultModels: {
        image: manifest.mediaUnderstandingProviderMetadata.moonshot.defaultModels.image,
        video: manifest.mediaUnderstandingProviderMetadata.moonshot.defaultModels.video,
      },
      autoPriority: { video: 20 },
      describeImage: undefined,
      describeImages: undefined,
      describeVideo: async (params) =>
        describeOpenAiCompatibleVideo({
          ...params,
          defaultBaseUrl: MOONSHOT_BASE_URL,
          defaultModel: manifest.mediaUnderstandingProviderMetadata.moonshot.defaultModels.video,
          defaultPrompt: "Describe the video.",
          provider: "moonshot",
          providerLabel: "Moonshot",
        }),
    });
    api.registerWebSearchProvider(createKimiWebSearchProvider());
  },
});
