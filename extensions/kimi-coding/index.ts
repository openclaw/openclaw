import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { applyKimiCodeConfig, KIMI_CODING_MODEL_REF } from "./onboard.js";
import { buildKimiCodingProvider } from "./provider-catalog.js";

const PLUGIN_ID = "kimi";
const PROVIDER_ID = "kimi";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Kimi Provider",
  description: "Bundled Kimi provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Kimi",
      aliases: ["kimi-code", "kimi-coding"],
      docsPath: "/providers/moonshot",
      envVars: ["KIMI_API_KEY", "KIMICODE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Kimi Code API key (subscription)",
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
            choiceLabel: "Kimi Code API key (subscription)",
            groupId: "moonshot",
            groupLabel: "Moonshot AI (Kimi K2.5)",
            groupHint: "Kimi K2.5",
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
        openAiPayloadNormalizationMode: "moonshot-thinking",
        preserveAnthropicThinkingSignatures: false,
      },
    });
  },
});
