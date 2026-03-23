import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyHpcAiConfig, HPC_AI_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildHpcAiProvider } from "./provider-catalog.js";

const PROVIDER_ID = "hpc-ai";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "HPC-AI Provider",
  description: "Bundled HPC-AI provider plugin",
  provider: {
    label: "HPC-AI",
    docsPath: "/providers/hpc-ai",
    auth: [
      {
        methodId: "api-key",
        label: "HPC-AI API key",
        hint: "API key",
        optionKey: "hpcAiApiKey",
        flagName: "--hpc-ai-api-key",
        envVar: "HPC_AI_API_KEY",
        promptMessage: "Enter HPC-AI API key",
        defaultModel: HPC_AI_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyHpcAiConfig(cfg),
        wizard: {
          groupLabel: "HPC-AI",
        },
      },
    ],
    catalog: {
      buildProvider: buildHpcAiProvider,
    },
  },
});
