import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { DEEPSEEK_THINKING_STREAM_HOOKS } from "openclaw/plugin-sdk/provider-stream-family";
import { applyDeepSeekConfig, DEEPSEEK_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildDeepSeekProvider } from "./provider-catalog.js";

const PROVIDER_ID = "deepseek";
const DEEPSEEK_V4_MODEL_IDS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);

function isDeepSeekV4ModelId(modelId: string | undefined): boolean {
  return modelId ? DEEPSEEK_V4_MODEL_IDS.has(modelId.trim().toLowerCase()) : false;
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "DeepSeek Provider",
  description: "Bundled DeepSeek provider plugin",
  provider: {
    label: "DeepSeek",
    docsPath: "/providers/deepseek",
    auth: [
      {
        methodId: "api-key",
        label: "DeepSeek API key",
        hint: "API key",
        optionKey: "deepseekApiKey",
        flagName: "--deepseek-api-key",
        envVar: "DEEPSEEK_API_KEY",
        promptMessage: "Enter DeepSeek API key",
        defaultModel: DEEPSEEK_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyDeepSeekConfig(cfg),
        wizard: {
          choiceId: "deepseek-api-key",
          choiceLabel: "DeepSeek API key",
          groupId: "deepseek",
          groupLabel: "DeepSeek",
          groupHint: "API key",
        },
      },
    ],
    catalog: {
      buildProvider: buildDeepSeekProvider,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    matchesContextOverflowError: ({ errorMessage }) =>
      /\bdeepseek\b.*(?:input.*too long|context.*exceed)/i.test(errorMessage),
    ...DEEPSEEK_THINKING_STREAM_HOOKS,
    resolveThinkingProfile: ({ modelId }) => {
      if (modelId === "deepseek-reasoner") {
        return {
          levels: [{ id: "low", label: "on" }],
          defaultLevel: "low",
        };
      }
      if (modelId === "deepseek-chat") {
        return {
          levels: [{ id: "off", label: "off" }],
          defaultLevel: "off",
        };
      }
      if (isDeepSeekV4ModelId(modelId)) {
        return {
          levels: [
            { id: "off", label: "off" },
            { id: "low", label: "on" },
          ],
          defaultLevel: "off",
        };
      }
      return undefined;
    },
  },
});
