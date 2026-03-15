import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildKimiCodingProvider } from "../../src/agents/models-config.providers.static.js";
import { isRecord } from "../../src/utils.js";

const PROVIDER_ID = "kimi-coding";

const kimiCodingPlugin = {
  id: PROVIDER_ID,
  name: "Kimi Coding Provider",
  description: "Bundled Kimi Coding provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Kimi Coding",
      aliases: ["kimi-code"],
      docsPath: "/providers/moonshot",
      envVars: ["KIMI_API_KEY", "KIMICODE_API_KEY"],
      auth: [],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          const explicitProvider = ctx.config.models?.providers?.[PROVIDER_ID];
          const builtInProvider = buildKimiCodingProvider();
          const explicitBaseUrl =
            typeof explicitProvider?.baseUrl === "string" ? explicitProvider.baseUrl.trim() : "";
          const explicitHeaders = isRecord(explicitProvider?.headers)
            ? explicitProvider.headers
            : undefined;
          return {
            provider: {
              ...builtInProvider,
              ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
              ...(explicitHeaders
                ? {
                    headers: {
                      ...builtInProvider.headers,
                      ...explicitHeaders,
                    },
                  }
                : {}),
              apiKey,
            },
          };
        },
      },
      capabilities: {
        preserveAnthropicThinkingSignatures: false,
      },
    });
  },
};

export default kimiCodingPlugin;
