import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { isRecord } from "openclaw/plugin-sdk/text-runtime";
import { applyKimiCodeConfig, KIMI_CODING_MODEL_REF } from "./onboard.js";
import { buildKimiCodingProvider } from "./provider-catalog.js";

const PROVIDER_ID = "kimi-coding";

const kimiCodingPlugin = {
  id: PROVIDER_ID,
  name: "Kimi Provider",
  description: "Bundled Kimi provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Kimi",
      aliases: ["kimi", "kimi-code"],
      docsPath: "/providers/moonshot",
      envVars: ["KIMI_API_KEY", "KIMICODE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Kimi API key (subscription)",
          hint: "Kimi K2.5 + Kimi",
          optionKey: "kimiCodeApiKey",
          flagName: "--kimi-code-api-key",
          envVar: "KIMI_API_KEY",
          promptMessage: "Enter Kimi API key",
          defaultModel: KIMI_CODING_MODEL_REF,
          expectedProviders: ["kimi", "kimi-code", "kimi-coding"],
          applyConfig: (cfg) => applyKimiCodeConfig(cfg),
          noteMessage: [
            "Kimi uses a dedicated coding endpoint and API key.",
            "Get your API key at: https://www.kimi.com/code/en",
          ].join("\n"),
          noteTitle: "Kimi",
          wizard: {
            choiceId: "kimi-code-api-key",
            choiceLabel: "Kimi API key (subscription)",
            groupId: "moonshot",
            groupLabel: "Moonshot AI (Kimi K2.5)",
            groupHint: "Kimi K2.5 + Kimi",
          },
        }),
      ],
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
