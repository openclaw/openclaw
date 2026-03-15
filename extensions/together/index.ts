import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildTogetherProvider } from "../../src/agents/models-config.providers.static.js";

const PROVIDER_ID = "together";

const togetherPlugin = {
  id: PROVIDER_ID,
  name: "Together Provider",
  description: "Bundled Together provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Together",
      docsPath: "/providers/together",
      envVars: ["TOGETHER_API_KEY"],
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
              ...buildTogetherProvider(),
              apiKey,
            },
          };
        },
      },
    });
  },
};

export default togetherPlugin;
