import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildSyntheticProvider } from "../../src/agents/models-config.providers.static.js";

const PROVIDER_ID = "synthetic";

const syntheticPlugin = {
  id: PROVIDER_ID,
  name: "Synthetic Provider",
  description: "Bundled Synthetic provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Synthetic",
      docsPath: "/providers/synthetic",
      envVars: ["SYNTHETIC_API_KEY"],
      auth: [],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...buildSyntheticProvider(),
              apiKey,
            },
          };
        },
      },
    });
  },
};

export default syntheticPlugin;
