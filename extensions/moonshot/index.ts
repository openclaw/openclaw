import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildMoonshotProvider } from "../../src/agents/models-config.providers.static.js";
import {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "../../src/agents/pi-embedded-runner/moonshot-stream-wrappers.js";

const PROVIDER_ID = "moonshot";

const moonshotPlugin = {
  id: PROVIDER_ID,
  name: "Moonshot Provider",
  description: "Bundled Moonshot provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Moonshot",
      docsPath: "/providers/moonshot",
      envVars: ["MOONSHOT_API_KEY"],
      auth: [],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          const explicitProvider = ctx.config.models?.providers?.[PROVIDER_ID];
          const explicitBaseUrl =
            typeof explicitProvider?.baseUrl === "string" ? explicitProvider.baseUrl.trim() : "";
          return {
            provider: {
              ...buildMoonshotProvider(),
              ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
              apiKey,
            },
          };
        },
      },
      wrapStreamFn: (ctx) => {
        const thinkingType = resolveMoonshotThinkingType({
          configuredThinking: ctx.extraParams?.thinking,
          thinkingLevel: ctx.thinkingLevel,
        });
        return createMoonshotThinkingWrapper(ctx.streamFn, thinkingType);
      },
    });
  },
};

export default moonshotPlugin;
