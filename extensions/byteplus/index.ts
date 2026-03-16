import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  buildBytePlusCodingProvider,
  buildBytePlusProvider,
} from "../../src/agents/models-config.providers.static.js";

const PROVIDER_ID = "byteplus";

const byteplusPlugin = {
  id: PROVIDER_ID,
  name: "BytePlus Provider",
  description: "Bundled BytePlus provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "BytePlus",
      docsPath: "/concepts/model-providers#byteplus-international",
      envVars: ["BYTEPLUS_API_KEY"],
      auth: [],
      catalog: {
        order: "paired",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            providers: {
              byteplus: { ...buildBytePlusProvider(), apiKey },
              "byteplus-plan": { ...buildBytePlusCodingProvider(), apiKey },
            },
          };
        },
      },
    });
  },
};

export default byteplusPlugin;
