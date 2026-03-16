import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  buildDoubaoCodingProvider,
  buildDoubaoProvider,
} from "../../src/agents/models-config.providers.static.js";

const PROVIDER_ID = "volcengine";

const volcenginePlugin = {
  id: PROVIDER_ID,
  name: "Volcengine Provider",
  description: "Bundled Volcengine provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Volcengine",
      docsPath: "/concepts/model-providers#volcano-engine-doubao",
      envVars: ["VOLCANO_ENGINE_API_KEY"],
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
              volcengine: { ...buildDoubaoProvider(), apiKey },
              "volcengine-plan": { ...buildDoubaoCodingProvider(), apiKey },
            },
          };
        },
      },
    });
  },
};

export default volcenginePlugin;
