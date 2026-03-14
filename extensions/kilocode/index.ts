import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildKilocodeProviderWithDiscovery } from "../../src/agents/models-config.providers.discovery.js";
import {
  createKilocodeWrapper,
  isProxyReasoningUnsupported,
} from "../../src/agents/pi-embedded-runner/proxy-stream-wrappers.js";
import { resolveKilocodeOrgId } from "../../src/providers/kilocode-shared.js";
import {
  applyKilocodeConfig,
  KILOCODE_DEFAULT_MODEL_REF,
} from "../../src/commands/onboard-auth.js";
import { createProviderApiKeyAuthMethod } from "../../src/plugins/provider-api-key-auth.js";

const PROVIDER_ID = "kilocode";

const kilocodePlugin = {
  id: PROVIDER_ID,
  name: "Kilo Gateway Provider",
  description: "Bundled Kilo Gateway provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Kilo Gateway",
      docsPath: "/providers/kilocode",
      envVars: ["KILOCODE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Kilo Gateway API key",
          hint: "API key (OpenRouter-compatible)",
          optionKey: "kilocodeApiKey",
          flagName: "--kilocode-api-key",
          envVar: "KILOCODE_API_KEY",
          promptMessage: "Enter Kilo Gateway API key",
          defaultModel: KILOCODE_DEFAULT_MODEL_REF,
          expectedProviders: ["kilocode"],
          applyConfig: (cfg) => applyKilocodeConfig(cfg),
          wizard: {
            choiceId: "kilocode-api-key",
            choiceLabel: "Kilo Gateway API key",
            groupId: "kilocode",
            groupLabel: "Kilo Gateway",
            groupHint: "API key (OpenRouter-compatible)",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
          if (!apiKey) {
            return null;
          }
          // Forward providerConfig so organizationId and headers from user
          // config are respected during org-scoped model discovery (not just
          // the env var fallback). See: kiloprovider key override support.
          const providerConfig = ctx.config?.models?.providers?.kilocode;
          return {
            provider: {
              ...(await buildKilocodeProviderWithDiscovery(discoveryApiKey, providerConfig)),
              apiKey,
            },
          };
        },
      },
      capabilities: {
        geminiThoughtSignatureSanitization: true,
        geminiThoughtSignatureModelHints: ["gemini"],
      },
      wrapStreamFn: (ctx) => {
        const thinkingLevel =
          ctx.modelId === "kilo/auto" || isProxyReasoningUnsupported(ctx.modelId)
            ? undefined
            : ctx.thinkingLevel;
        // Resolve org ID from config (organizationId field or headers) with env var fallback.
        const kilocodeOrgId = resolveKilocodeOrgId(ctx.config?.models?.providers?.kilocode);
        return createKilocodeWrapper(ctx.streamFn, thinkingLevel, kilocodeOrgId);
      },
      isCacheTtlEligible: (ctx) => ctx.modelId.startsWith("anthropic/"),
    });
  },
};

export default kilocodePlugin;
