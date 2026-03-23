import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { PROVIDER_LABELS } from "../../src/infra/provider-usage.shared.js";
import { createProviderApiKeyAuthMethod } from "../../src/plugins/provider-api-key-auth.js";
import { buildSingleProviderApiKeyCatalog } from "../../src/plugins/provider-catalog.js";
import { applyXiaomiConfig, XIAOMI_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildXiaomiProvider } from "./provider-catalog.js";

const PROVIDER_ID = "xiaomi";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Xiaomi Provider",
  description: "Bundled Xiaomi provider plugin",
  provider: {
    label: "Xiaomi",
    docsPath: "/providers/xiaomi",
    auth: [
      {
        methodId: "api-key",
        label: "Xiaomi API key",
        hint: "API key",
        optionKey: "xiaomiApiKey",
        flagName: "--xiaomi-api-key",
        envVar: "XIAOMI_API_KEY",
        promptMessage: "Enter Xiaomi API key",
        defaultModel: XIAOMI_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyXiaomiConfig(cfg),
      },
    ],
    catalog: {
      buildProvider: buildXiaomiProvider,
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
  },
});
