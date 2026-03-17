import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { applyHuggingfaceConfig, HUGGINGFACE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildHuggingfaceProvider } from "./provider-catalog.js";

const PROVIDER_ID = "huggingface";

const huggingfacePlugin = {
  id: PROVIDER_ID,
  name: "Hugging Face Provider",
  description: "Bundled Hugging Face provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Hugging Face",
      docsPath: "/providers/huggingface",
      envVars: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Hugging Face API key",
          hint: "Inference API (HF token)",
          optionKey: "huggingfaceApiKey",
          flagName: "--huggingface-api-key",
          envVar: "HUGGINGFACE_HUB_TOKEN",
          promptMessage: "Enter Hugging Face API key",
          defaultModel: HUGGINGFACE_DEFAULT_MODEL_REF,
          expectedProviders: ["huggingface"],
          applyConfig: (cfg) => applyHuggingfaceConfig(cfg),
          wizard: {
            choiceId: "huggingface-api-key",
            choiceLabel: "Hugging Face API key",
            choiceHint: "Inference API (HF token)",
            groupId: "huggingface",
            groupLabel: "Hugging Face",
            groupHint: "Inference API (HF token)",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
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
    });
  },
};

export default huggingfacePlugin;
