import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import { buildOpenAICompatibleLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import {
  projectBasetenLiveModels,
  resolveBasetenDynamicModel,
  usesBasetenChatTemplateThinking,
} from "./models.js";
import { applyBasetenSetupConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildStaticBasetenProvider } from "./provider-catalog.js";
import { createBasetenThinkingWrapper } from "./stream.js";

const PROVIDER_ID = "baseten";

const BASETEN_BINARY_THINKING_PROFILE = {
  levels: [{ id: "off" }, { id: "low", label: "on" }],
  defaultLevel: "off",
} as const satisfies ProviderThinkingProfile;

const BASETEN_GLM_52_THINKING_PROFILE = {
  levels: [{ id: "off" }, { id: "high" }, { id: "max" }],
  defaultLevel: "off",
} as const satisfies ProviderThinkingProfile;

const BASETEN_DEEPSEEK_THINKING_PROFILE = {
  levels: [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }],
} as const satisfies ProviderThinkingProfile;

const BASETEN_DEEPSEEK_V41_THINKING_PROFILE = {
  ...BASETEN_DEEPSEEK_THINKING_PROFILE,
  defaultLevel: "high",
} as const satisfies ProviderThinkingProfile;

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Baseten Provider",
  description: "Official Baseten Model APIs provider plugin",
  manifest,
  provider: {
    label: "Baseten",
    docsPath: "/providers/baseten",
    manifestAuth: {
      applyConfig: applyBasetenSetupConfig,
      preserveExistingPrimary: true,
      noteTitle: "Baseten",
      noteMessage: [
        "Baseten hosts DeepSeek V4.1 Flash and other models behind one OpenAI-compatible API.",
        "Get your API key at: https://app.baseten.co/settings/api_keys",
      ].join("\n"),
    },
    catalog: {
      order: "simple",
      run: async (ctx: ProviderCatalogContext) => {
        const { apiKey, discoveryApiKey, profileId } = ctx.resolveProviderAuth(PROVIDER_ID);
        if (!apiKey) {
          return null;
        }
        if (!discoveryApiKey) {
          return { provider: { ...buildStaticBasetenProvider(), apiKey } };
        }
        return await buildOpenAICompatibleLiveProviderCatalog({
          discoveryMode: "strict",
          providerId: PROVIDER_ID,
          providerConfig: buildStaticBasetenProvider(),
          apiKey,
          discoveryApiKey,
          profileId,
          modelDiscovery: {
            timeoutMs: 10_000,
            ttlMs: 5 * 60 * 1000,
            projectRows: projectBasetenLiveModels,
          },
        });
      },
      staticRun: async () => ({ provider: buildStaticBasetenProvider() }),
    },
    resolveDynamicModel: ({ modelId }) => resolveBasetenDynamicModel(modelId),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    wrapStreamFn: createBasetenThinkingWrapper,
    wrapSimpleCompletionStreamFn: createBasetenThinkingWrapper,
    resolveThinkingProfile: ({ modelId }) => {
      const normalized = modelId.trim().toLowerCase();
      if (normalized === "deepseek-ai/deepseek-v4.1-flash") {
        return BASETEN_DEEPSEEK_V41_THINKING_PROFILE;
      }
      if (normalized === "deepseek-ai/deepseek-v4-pro-0813") {
        return BASETEN_DEEPSEEK_THINKING_PROFILE;
      }
      if (normalized === "zai-org/glm-5.2" || normalized === "zai-org/glm-5.2-fast") {
        return BASETEN_GLM_52_THINKING_PROFILE;
      }
      return usesBasetenChatTemplateThinking(normalized)
        ? BASETEN_BINARY_THINKING_PROFILE
        : undefined;
    },
    isModernModelRef: () => true,
  },
});
