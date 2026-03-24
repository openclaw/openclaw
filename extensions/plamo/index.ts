import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyPlamoConfig, PLAMO_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildPlamoProvider } from "./provider-catalog.js";
import { createPlamoToolCallWrapper } from "./stream.js";

const PROVIDER_ID = "plamo";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "PLaMo Provider",
  description: "Bundled PLaMo provider plugin",
  provider: {
    label: "PLaMo",
    docsPath: "/providers/models",
    auth: [
      {
        methodId: "api-key",
        label: "PLaMo API key",
        hint: "API key",
        optionKey: "plamoApiKey",
        flagName: "--plamo-api-key",
        envVar: "PLAMO_API_KEY",
        promptMessage: "Enter PLaMo API key",
        defaultModel: PLAMO_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyPlamoConfig(cfg),
        wizard: {
          choiceId: "plamo-api-key",
          choiceLabel: "PLaMo API key",
          groupId: "plamo",
          groupLabel: "PLaMo",
          groupHint: "API key",
        },
      },
    ],
    catalog: {
      buildProvider: buildPlamoProvider,
      allowExplicitBaseUrl: true,
    },
    capabilities: {
      dropThinkingBlockModelHints: ["plamo"],
    },
    wrapStreamFn: ({ streamFn, extraParams }) =>
      createPlamoToolCallWrapper(streamFn, {
        useSyntheticStream: extraParams?.plamoSyntheticStream !== false,
      }),
  },
});
