import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applySambanovaConfig, SAMBANOVA_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildSambanovaProvider } from "./provider-catalog.js";

const PROVIDER_ID = "sambanova";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "SambaNova Provider",
  description: "Bundled SambaNova provider plugin",
  provider: {
    label: "SambaNova",
    docsPath: "/providers/sambanova",
    auth: [
      {
        methodId: "api-key",
        label: "SambaNova API key",
        hint: "Fast inference for open-source models",
        optionKey: "sambanovaApiKey",
        flagName: "--sambanova-api-key",
        envVar: "SAMBANOVA_API_KEY",
        promptMessage: "Enter SambaNova API key",
        defaultModel: SAMBANOVA_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applySambanovaConfig(cfg),
        noteMessage: [
          "SambaNova provides fast inference using RDU AI accelerator chips.",
          "Get your API key at: https://cloud.sambanova.ai/apis",
        ].join("\n"),
        noteTitle: "SambaNova",
        wizard: {
          groupLabel: "SambaNova",
        },
      },
    ],
    catalog: {
      buildProvider: buildSambanovaProvider,
    },
  },
});
