import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildXiaomiProvider } from "../../src/agents/models-config.providers.static.js";
import { PROVIDER_LABELS } from "../../src/infra/provider-usage.shared.js";

const PROVIDER_ID = "xiaomi";

const xiaomiPlugin = {
  id: PROVIDER_ID,
  name: "Xiaomi Provider",
  description: "Bundled Xiaomi provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Xiaomi",
      docsPath: "/providers/xiaomi",
      envVars: ["XIAOMI_API_KEY"],
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
              ...buildXiaomiProvider(),
              apiKey,
            },
          };
        },
      },
      resolveUsageAuth: async (ctx) => {
        const apiKey = ctx.resolveApiKeyFromConfigAndStore({
          envDirect: [ctx.env.XIAOMI_API_KEY],
        });
        return apiKey ? { token: apiKey } : null;
      },
      fetchUsageSnapshot: async () => ({
        provider: "xiaomi",
        displayName: PROVIDER_LABELS.xiaomi,
        windows: [],
      }),
    });
  },
};

export default xiaomiPlugin;
