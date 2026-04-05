import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyArceeConfig, ARCEE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildArceeProvider } from "./provider-catalog.js";

const PROVIDER_ID = "arcee";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Arcee AI Provider",
  description: "Bundled Arcee AI provider plugin",
  provider: {
    label: "Arcee AI",
    docsPath: "/providers/arcee",
    auth: [
      {
        methodId: "api-key",
        label: "Arcee AI API key",
        hint: "API key",
        optionKey: "arceeaiApiKey",
        flagName: "--arceeai-api-key",
        envVar: "ARCEEAI_API_KEY",
        promptMessage: "Enter Arcee AI API key",
        defaultModel: ARCEE_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyArceeConfig(cfg),
        wizard: {
          choiceId: "arceeai-api-key",
          choiceLabel: "Arcee AI API key",
          groupId: "arcee",
          groupLabel: "Arcee AI",
          groupHint: "API key",
        },
      },
    ],
    catalog: {
      buildProvider: buildArceeProvider,
      allowExplicitBaseUrl: true,
    },
  },
});
