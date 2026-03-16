import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildHuggingfaceProvider } from "../../src/agents/models-config.providers.discovery.js";

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
      auth: [],
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
