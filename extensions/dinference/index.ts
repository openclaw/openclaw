import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyDinferenceConfig, DINFERENCE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildDinferenceProvider } from "./provider-catalog.js";

const PROVIDER_ID = "dinference";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "DInference Provider",
  description: "Bundled DInference provider plugin",
  provider: {
    label: "DInference",
    docsPath: "/providers/dinference",
    auth: [
      {
        methodId: "api-key",
        label: "DInference API key",
        hint: "Open source models (GLM-5, GLM-4.7, GPT-OSS-120b)",
        optionKey: "dinferenceApiKey",
        flagName: "--dinference-api-key",
        envVar: "DINFERENCE_API_KEY",
        promptMessage: "Enter DInference API key",
        defaultModel: DINFERENCE_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyDinferenceConfig(cfg),
        wizard: {
          groupLabel: "DInference",
        },
      },
    ],
    catalog: {
      buildProvider: buildDinferenceProvider,
    },
  },
});
