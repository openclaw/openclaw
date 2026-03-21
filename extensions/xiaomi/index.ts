import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import { PROVIDER_LABELS } from "openclaw/plugin-sdk/provider-usage";
import { applyXiaomiConfig, XIAOMI_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildXiaomiProvider } from "./provider-catalog.js";

const PROVIDER_ID = "xiaomi";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Xiaomi Provider",
  description: "Bundled Xiaomi provider plugin",
  register(api) {
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
});
