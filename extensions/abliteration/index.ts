import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyAbliterationConfig, ABLITERATION_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildAbliterationProvider } from "./provider-catalog.js";

const PROVIDER_ID = "abliteration";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Abliteration Provider",
  description: "Bundled Abliteration provider plugin",
  provider: {
    label: "Abliteration",
    docsPath: "/providers/abliteration",
    auth: [
      {
        methodId: "api-key",
        label: "Abliteration API key",
        hint: "Anthropic-compatible",
        optionKey: "abliterationApiKey",
        flagName: "--abliteration-api-key",
        envVar: "ABLITERATION_API_KEY",
        promptMessage: "Enter Abliteration API key",
        defaultModel: ABLITERATION_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyAbliterationConfig(cfg),
        wizard: {
          choiceId: "abliteration-api-key",
          choiceLabel: "Abliteration API key",
          groupId: "abliteration",
          groupLabel: "Abliteration",
          groupHint: "Anthropic-compatible",
        },
      },
    ],
    catalog: {
      buildProvider: buildAbliterationProvider,
    },
  },
});
