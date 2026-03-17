import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { PROVIDER_LABELS } from "../../src/infra/provider-usage.shared.js";
import { createProviderApiKeyAuthMethod } from "../../src/plugins/provider-api-key-auth.js";
import { applyXiaomiConfig, XIAOMI_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildSingleProviderApiKeyCatalog } from "../../src/plugins/provider-catalog.js";
import { buildXiaomiProvider } from "./provider-catalog.js";

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
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Xiaomi API key",
          hint: "API key",
          optionKey: "xiaomiApiKey",
          flagName: "--xiaomi-api-key",
          envVar: "XIAOMI_API_KEY",
          promptMessage: "Enter Xiaomi API key",
          defaultModel: XIAOMI_DEFAULT_MODEL_REF,
          expectedProviders: ["xiaomi"],
          applyConfig: (cfg) => applyXiaomiConfig(cfg),
          wizard: {
            choiceId: "xiaomi-api-key",
            choiceLabel: "Xiaomi API key",
            groupId: "xiaomi",
            groupLabel: "Xiaomi",
            groupHint: "API key",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildXiaomiProvider,
          }),
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
