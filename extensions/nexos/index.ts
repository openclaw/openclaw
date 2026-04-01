import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyNexosConfig, NEXOS_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildNexosProvider } from "./provider-catalog.js";

const PROVIDER_ID = "nexos";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Nexos Provider",
  description: "Bundled Nexos AI provider plugin",
  provider: {
    label: "Nexos AI",
    docsPath: "/providers/nexos",
    auth: [
      {
        methodId: "api-key",
        label: "Nexos AI API key",
        hint: "API key",
        optionKey: "nexosApiKey",
        flagName: "--nexos-api-key",
        envVar: "NEXOS_API_KEY",
        promptMessage: "Enter Nexos AI API key",
        defaultModel: NEXOS_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyNexosConfig(cfg),
        wizard: {
          groupLabel: "Nexos AI",
        },
      },
    ],
    catalog: {
      buildProvider: buildNexosProvider,
    },
  },
});
