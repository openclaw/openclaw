import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "../../src/plugins/provider-api-key-auth.js";
import { isRecord } from "../../src/utils.js";
import { applyKimiCodeConfig, KIMI_CODING_MODEL_REF } from "./onboard.js";
import { buildKimiCodingProvider } from "./provider-catalog.js";

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
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Kimi Code API key (subscription)",
          hint: "Kimi K2.5 + Kimi Coding",
          optionKey: "kimiCodeApiKey",
          flagName: "--kimi-code-api-key",
          envVar: "KIMI_API_KEY",
          promptMessage: "Enter Kimi Coding API key",
          defaultModel: KIMI_CODING_MODEL_REF,
          expectedProviders: ["kimi-code", "kimi-coding"],
          applyConfig: (cfg) => applyKimiCodeConfig(cfg),
          noteMessage: [
            "Kimi Coding uses a dedicated endpoint and API key.",
            "Get your API key at: https://www.kimi.com/code/en",
          ].join("\n"),
          noteTitle: "Kimi Coding",
          wizard: {
            choiceId: "kimi-code-api-key",
            choiceLabel: "Kimi Code API key (subscription)",
            groupId: "moonshot",
            groupLabel: "Moonshot AI (Kimi K2.5)",
            groupHint: "Kimi K2.5 + Kimi Coding",
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
