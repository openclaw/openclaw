import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyFuturMixConfig, FUTURMIX_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildFuturMixProvider } from "./provider-catalog.js";

const PROVIDER_ID = "futurmix";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "FuturMix Provider",
  description: "FuturMix AI gateway provider plugin",
  provider: {
    label: "FuturMix",
    docsPath: "/providers/futurmix",
    auth: [
      {
        methodId: "api-key",
        label: "FuturMix API key",
        hint: "API key",
        optionKey: "futurmixApiKey",
        flagName: "--futurmix-api-key",
        envVar: "FUTURMIX_API_KEY",
        promptMessage: "Enter FuturMix API key",
        defaultModel: FUTURMIX_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyFuturMixConfig(cfg),
        wizard: {
          groupLabel: "FuturMix",
        },
      },
    ],
    catalog: {
      buildProvider: buildFuturMixProvider,
    },
  },
});
