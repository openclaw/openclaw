import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildModelStudioProvider } from "../../src/agents/models-config.providers.static.js";

const PROVIDER_ID = "modelstudio";

const modelStudioPlugin = {
  id: PROVIDER_ID,
  name: "Model Studio Provider",
  description: "Bundled Model Studio provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Model Studio",
      docsPath: "/providers/models",
      envVars: ["MODELSTUDIO_API_KEY"],
      auth: [],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          const explicitProvider = ctx.config.models?.providers?.[PROVIDER_ID];
          const explicitBaseUrl =
            typeof explicitProvider?.baseUrl === "string" ? explicitProvider.baseUrl.trim() : "";
          return {
            provider: {
              ...buildModelStudioProvider(),
              ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
              apiKey,
            },
          };
        },
      },
    });
  },
};

export default modelStudioPlugin;
