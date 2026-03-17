import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/core";
import { findNormalizedProviderValue, normalizeProviderId } from "../../src/agents/provider-id.js";
import { createProviderApiKeyAuthMethod } from "../../src/plugins/provider-api-key-auth.js";
import { isRecord } from "../../src/utils.js";
import { applyKimiCodeConfig, KIMI_DEFAULT_MODEL_REF } from "./onboard.js";
import {
  buildKimiProvider,
  KIMI_DEFAULT_MODEL_ID,
  KIMI_LEGACY_MODEL_ID,
  KIMI_UPSTREAM_MODEL_ID,
} from "./provider-catalog.js";

const PROVIDER_ID = "kimi";
const KIMI_TRANSPORT_MODEL_IDS = new Set([KIMI_DEFAULT_MODEL_ID, KIMI_LEGACY_MODEL_ID]);

function normalizeKimiTransportModel(model: ProviderRuntimeModel): ProviderRuntimeModel {
  if (!KIMI_TRANSPORT_MODEL_IDS.has(model.id)) {
    return model;
  }
  return {
    ...model,
    id: KIMI_UPSTREAM_MODEL_ID,
    name: "Kimi Code",
  };
}

const kimiCodingPlugin = {
  id: PROVIDER_ID,
  name: "Kimi Code Provider",
  description: "Bundled Kimi Code provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Kimi Code",
      aliases: ["kimi-code", "kimi-coding"],
      docsPath: "/providers/moonshot",
      envVars: ["KIMI_API_KEY", "KIMICODE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Kimi Code API key",
          hint: "Dedicated coding endpoint",
          optionKey: "kimiCodeApiKey",
          flagName: "--kimi-code-api-key",
          envVar: "KIMI_API_KEY",
          promptMessage: "Enter Kimi Code API key",
          defaultModel: KIMI_DEFAULT_MODEL_REF,
          expectedProviders: ["kimi", "kimi-code", "kimi-coding"],
          applyConfig: (cfg) => applyKimiCodeConfig(cfg),
          noteMessage: [
            "Kimi Code uses a dedicated coding endpoint and API key.",
            "Get your API key at: https://www.kimi.com/code/en",
          ].join("\n"),
          noteTitle: "Kimi Code",
          wizard: {
            choiceId: "kimi-code-api-key",
            choiceLabel: "Kimi Code API key",
            groupId: "kimi-code",
            groupLabel: "Kimi Code",
            groupHint: "Dedicated coding endpoint",
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
          const explicitProvider = findNormalizedProviderValue(
            ctx.config.models?.providers,
            PROVIDER_ID,
          );
          const builtInProvider = buildKimiProvider();
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
      normalizeResolvedModel: (ctx) => {
        if (normalizeProviderId(ctx.provider) !== PROVIDER_ID) {
          return undefined;
        }
        return normalizeKimiTransportModel(ctx.model);
      },
    });
  },
};

export default kimiCodingPlugin;
