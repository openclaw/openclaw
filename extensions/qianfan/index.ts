import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildQianfanProvider } from "../../src/agents/models-config.providers.static.js";

const PROVIDER_ID = "qianfan";

const qianfanPlugin = {
  id: PROVIDER_ID,
  name: "Qianfan Provider",
  description: "Bundled Qianfan provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Qianfan",
      docsPath: "/providers/qianfan",
      envVars: ["QIANFAN_API_KEY"],
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
              ...buildQianfanProvider(),
              apiKey,
            },
          };
        },
      },
    });
  },
};

export default qianfanPlugin;
