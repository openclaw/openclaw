import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildMinimaxProvider } from "../../src/agents/models-config.providers.static.js";

const PROVIDER_ID = "minimax";

const minimaxPlugin = {
  id: PROVIDER_ID,
  name: "MiniMax Provider",
  description: "Bundled MiniMax provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "MiniMax",
      docsPath: "/providers/minimax",
      envVars: ["MINIMAX_API_KEY"],
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
              ...buildMinimaxProvider(),
              apiKey,
            },
          };
        },
      },
    });
  },
};

export default minimaxPlugin;
