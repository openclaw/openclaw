import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildHuggingfaceImageGenerationProvider } from "./image-generation-provider.js";
import { applyHuggingfaceConfig, HUGGINGFACE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildHuggingfaceProvider } from "./provider-catalog.js";

const PROVIDER_ID = "huggingface";

type HuggingFacePluginConfig = {
  discovery?: {
    enabled?: boolean;
  };
};

const baseEntry = defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Hugging Face Provider",
  description: "Bundled Hugging Face provider plugin",
  provider: {
    label: "Hugging Face",
    docsPath: "/providers/huggingface",
    envVars: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
    auth: [
      {
        methodId: "api-key",
        label: "Hugging Face API key",
        hint: "Inference API (HF token)",
        optionKey: "huggingfaceApiKey",
        flagName: "--huggingface-api-key",
        envVar: "HUGGINGFACE_HUB_TOKEN",
        promptMessage: "Enter Hugging Face API key",
        defaultModel: HUGGINGFACE_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyHuggingfaceConfig(cfg),
      },
    ],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const pluginEntry = ctx.config?.plugins?.entries?.[PROVIDER_ID];
        const pluginConfig =
          pluginEntry && typeof pluginEntry === "object" && pluginEntry.config
            ? (pluginEntry.config as HuggingFacePluginConfig)
            : undefined;
        const discoveryEnabled =
          pluginConfig?.discovery?.enabled ?? ctx.config?.models?.huggingfaceDiscovery?.enabled;
        if (discoveryEnabled === false) {
          return null;
        }
        const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
        if (!apiKey) {
          return null;
        }
        return {
          provider: {
            ...(await buildHuggingfaceProvider(discoveryApiKey)),
            apiKey,
          },
        };
      },
    },
  },
});

const baseRegister = baseEntry.register;
export default {
  ...baseEntry,
  register(api: Parameters<typeof baseRegister>[0]) {
    baseRegister(api);
    api.registerImageGenerationProvider(buildHuggingfaceImageGenerationProvider());
  },
};
