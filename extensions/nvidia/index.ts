import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildNimProvider } from "./provider-catalog.js";

const PROVIDER_ID = "nvidia";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "NVIDIA NIM Provider",
  description: "Bundled NVIDIA NIM provider plugin for inference microservices",
  provider: {
    label: "NVIDIA NIM",
    docsPath: "/providers/nvidia",
    envVars: ["NVIDIA_API_KEY"],
    auth: [],
    catalog: {
      buildProvider: buildNimProvider,
    },
  },
});
