import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import { buildNvidiaProvider } from "./provider-catalog.js";

const PROVIDER_ID = "nvidia";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "NVIDIA Provider",
  description: "Bundled NVIDIA provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "NVIDIA",
      docsPath: "/providers/nvidia",
      envVars: ["NVIDIA_API_KEY"],
      auth: [],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildNvidiaProvider,
          }),
      },
    });
  },
});
