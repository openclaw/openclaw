import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyFeatherlessConfig, FEATHERLESS_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildFeatherlessProvider } from "./provider-catalog.js";

const PROVIDER_ID = "featherless";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Featherless Provider",
  description: "Bundled Featherless provider plugin",
  provider: {
    label: "Featherless",
    docsPath: "/providers/featherless",
    auth: [
      {
        methodId: "api-key",
        label: "Featherless AI API key",
        hint: "API key",
        optionKey: "featherlessApiKey",
        flagName: "--featherless-api-key",
        envVar: "FEATHERLESS_API_KEY",
        promptMessage: "Enter Featherless AI API key",
        defaultModel: FEATHERLESS_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyFeatherlessConfig(cfg),
        wizard: {
          groupLabel: "Featherless AI",
        },
      },
    ],
    catalog: {
      buildProvider: buildFeatherlessProvider,
    },
  },
});
