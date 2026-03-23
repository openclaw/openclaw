import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "../../src/plugins/provider-api-key-auth.js";
import { buildSingleProviderApiKeyCatalog } from "../../src/plugins/provider-catalog.js";
import { applyTogetherConfig, TOGETHER_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildTogetherProvider } from "./provider-catalog.js";

const PROVIDER_ID = "together";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Together Provider",
  description: "Bundled Together provider plugin",
  provider: {
    label: "Together",
    docsPath: "/providers/together",
    auth: [
      {
        methodId: "api-key",
        label: "Together AI API key",
        hint: "API key",
        optionKey: "togetherApiKey",
        flagName: "--together-api-key",
        envVar: "TOGETHER_API_KEY",
        promptMessage: "Enter Together AI API key",
        defaultModel: TOGETHER_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyTogetherConfig(cfg),
        wizard: {
          groupLabel: "Together AI",
        },
      },
    ],
    catalog: {
      buildProvider: buildTogetherProvider,
    },
  },
});
