import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyNvidiaConfig, NVIDIA_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildNvidiaProvider } from "./provider-catalog.js";

const PROVIDER_ID = "nvidia";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "NVIDIA Provider",
  description: "Bundled NVIDIA provider plugin",
  provider: {
    label: "NVIDIA",
    docsPath: "/providers/nvidia",
    envVars: ["NVIDIA_API_KEY"],
    auth: [
      {
        methodId: "api-key",
        label: "NVIDIA API key",
        hint: "Free at build.nvidia.com",
        optionKey: "nvidiaApiKey",
        flagName: "--nvidia-api-key",
        envVar: "NVIDIA_API_KEY",
        promptMessage: "Enter NVIDIA API key (get one at build.nvidia.com)",
        defaultModel: NVIDIA_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyNvidiaConfig(cfg),
        wizard: {
          groupLabel: "NVIDIA",
        },
      },
    ],
    catalog: {
      buildProvider: buildNvidiaProvider,
    },
  },
});
