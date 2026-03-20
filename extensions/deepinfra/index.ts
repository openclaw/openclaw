import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import {
  createDeepInfraSystemCacheWrapper,
  createDeepInfraWrapper,
  isProxyReasoningUnsupported,
} from "openclaw/plugin-sdk/provider-stream";
import { applyDeepInfraConfig, DEEPINFRA_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildDeepInfraProviderWithDiscovery } from "./provider-catalog.js";

const PROVIDER_ID = "deepinfra";

const DEEPINFRA_CACHE_TTL_MODEL_PREFIXES = [
  "anthropic/",
  "moonshot/",
  "moonshotai/",
  "zai/",
  "zai-org/",
] as const;

function isDeepInfraCacheTtlModel(modelId: string): boolean {
  return DEEPINFRA_CACHE_TTL_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "DeepInfra Provider",
  description: "Bundled DeepInfra provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "DeepInfra",
      docsPath: "/providers/deepinfra",
      envVars: ["DEEPINFRA_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "DeepInfra API key",
          hint: "Unified API for open source models",
          optionKey: "deepinfraApiKey",
          flagName: "--deepinfra-api-key",
          envVar: "DEEPINFRA_API_KEY",
          promptMessage: "Enter DeepInfra API key",
          defaultModel: DEEPINFRA_DEFAULT_MODEL_REF,
          expectedProviders: ["deepinfra"],
          applyConfig: (cfg) => applyDeepInfraConfig(cfg),
          wizard: {
            choiceId: "deepinfra-api-key",
            choiceLabel: "DeepInfra API key",
            groupId: "deepinfra",
            groupLabel: "DeepInfra",
            groupHint: "Unified API for open source models",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildDeepInfraProviderWithDiscovery,
          }),
      },
      capabilities: {
        openAiCompatTurnValidation: false,
        geminiThoughtSignatureSanitization: true,
        geminiThoughtSignatureModelHints: ["gemini"],
        dropThinkingBlockModelHints: ["claude"],
      },
      wrapStreamFn: (ctx) => {
        const thinkingLevel = isProxyReasoningUnsupported(ctx.modelId)
          ? undefined
          : ctx.thinkingLevel;
        let streamFn = createDeepInfraWrapper(ctx.streamFn, thinkingLevel);
        streamFn = createDeepInfraSystemCacheWrapper(streamFn);
        return streamFn;
      },
      isCacheTtlEligible: (ctx) => isDeepInfraCacheTtlModel(ctx.modelId),
    });
  },
});
