import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildVercelAiGatewayProvider } from "../../src/agents/models-config.providers.discovery.js";

const PROVIDER_ID = "vercel-ai-gateway";

const vercelAiGatewayPlugin = {
  id: PROVIDER_ID,
  name: "Vercel AI Gateway Provider",
  description: "Bundled Vercel AI Gateway provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Vercel AI Gateway",
      docsPath: "/providers/vercel-ai-gateway",
      envVars: ["AI_GATEWAY_API_KEY"],
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
              ...(await buildVercelAiGatewayProvider()),
              apiKey,
            },
          };
        },
      },
    });
  },
};

export default vercelAiGatewayPlugin;
