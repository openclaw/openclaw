import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyQiniuConfig, QINIU_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildQiniuProvider } from "./provider-catalog.js";

const PROVIDER_ID = "qiniu";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Qiniu Provider",
  description: "Bundled Qiniu provider plugin",
  provider: {
    label: "Qiniu",
    docsPath: "/providers/qiniu",
    auth: [
      {
        methodId: "api-key",
        label: "Qiniu API key",
        hint: "API key",
        optionKey: "qiniuApiKey",
        flagName: "--qiniu-api-key",
        envVar: "QINIU_API_KEY",
        promptMessage: "Enter Qiniu API key",
        defaultModel: QINIU_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyQiniuConfig(cfg),
        wizard: {
          choiceId: "qiniu-api-key",
          choiceLabel: "Qiniu API key",
          groupId: "qiniu",
          groupLabel: "Qiniu",
          groupHint: "API key",
        },
      },
    ],
    catalog: {
      run: async (ctx) => {
        const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
        if (!apiKey) {
          return null;
        }
        return {
          provider: {
            ...(await buildQiniuProvider(apiKey)),
            apiKey,
          },
        };
      },
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
  },
});
