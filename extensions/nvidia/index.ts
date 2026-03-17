import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildNvidiaProvider } from "./provider-catalog.js";

const PROVIDER_ID = "nvidia";

const nvidiaPlugin = {
  id: PROVIDER_ID,
  name: "NVIDIA Provider",
  description: "Bundled NVIDIA provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "NVIDIA",
      docsPath: "/providers/nvidia",
      envVars: ["NVIDIA_API_KEY"],
      auth: [],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...buildNvidiaProvider(),
              apiKey,
            },
          };
        },
      },
    });
  },
};

export default nvidiaPlugin;
