import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildVeniceProvider } from "../../src/agents/models-config.providers.discovery.js";

const PROVIDER_ID = "venice";

const venicePlugin = {
  id: PROVIDER_ID,
  name: "Venice Provider",
  description: "Bundled Venice provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Venice",
      docsPath: "/providers/venice",
      envVars: ["VENICE_API_KEY"],
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
              ...(await buildVeniceProvider()),
              apiKey,
            },
          };
        },
      },
    });
  },
};

export default venicePlugin;
