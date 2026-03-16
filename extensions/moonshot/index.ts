import { buildMoonshotProvider } from "../../src/agents/models-config.providers.static.js";
import {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "../../src/agents/pi-embedded-runner/moonshot-stream-wrappers.js";
import {
  createPluginBackedWebSearchProvider,
  getScopedCredentialValue,
  setScopedCredentialValue,
} from "../../src/agents/tools/web-search-plugin-factory.js";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";

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
    api.registerWebSearchProvider(
      createPluginBackedWebSearchProvider({
        id: "kimi",
        label: "Kimi (Moonshot)",
        hint: "Moonshot web search",
        envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
        placeholder: "sk-...",
        signupUrl: "https://platform.moonshot.cn/",
        docsUrl: "https://docs.openclaw.ai/tools/web",
        autoDetectOrder: 40,
        getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "kimi"),
        setCredentialValue: (searchConfigTarget, value) =>
          setScopedCredentialValue(searchConfigTarget, "kimi", value),
      }),
    );
  },
};

export default moonshotPlugin;
