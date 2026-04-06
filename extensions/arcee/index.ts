import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import {
  applyArceeConfig,
  applyArceeOpenRouterConfig,
  ARCEE_DEFAULT_MODEL_REF,
  ARCEE_OPENROUTER_DEFAULT_MODEL_REF,
} from "./onboard.js";
import {
  buildArceeProvider,
  buildArceeOpenRouterProvider,
  isArceeOpenRouterBaseUrl,
  toArceeOpenRouterModelId,
} from "./provider-catalog.js";

const PROVIDER_ID = "arcee";
const OPENAI_COMPATIBLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "openai-compatible",
});

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Arcee AI Provider",
  description: "Bundled Arcee AI provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Arcee AI",
      docsPath: "/providers/arcee",
      envVars: ["ARCEEAI_API_KEY", "OPENROUTER_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "arcee-platform",
          label: "Arcee AI API key",
          hint: "Direct access to Arcee platform",
          optionKey: "arceeaiApiKey",
          flagName: "--arceeai-api-key",
          envVar: "ARCEEAI_API_KEY",
          promptMessage: "Enter Arcee AI API key",
          defaultModel: ARCEE_DEFAULT_MODEL_REF,
          expectedProviders: [PROVIDER_ID],
          applyConfig: (cfg) => applyArceeConfig(cfg),
          wizard: {
            choiceId: "arceeai-api-key",
            choiceLabel: "Arcee AI API key",
            choiceHint: "Direct (chat.arcee.ai)",
            groupId: "arcee",
            groupLabel: "Arcee AI",
            groupHint: "Direct API or OpenRouter",
          },
        }),
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "openrouter",
          label: "OpenRouter API key",
          hint: "Access Arcee models via OpenRouter",
          optionKey: "openrouterApiKey",
          flagName: "--openrouter-api-key",
          envVar: "OPENROUTER_API_KEY",
          promptMessage: "Enter OpenRouter API key",
          profileId: "openrouter:default",
          defaultModel: ARCEE_OPENROUTER_DEFAULT_MODEL_REF,
          expectedProviders: [PROVIDER_ID, "openrouter"],
          applyConfig: (cfg) => applyArceeOpenRouterConfig(cfg),
          wizard: {
            choiceId: "arceeai-openrouter",
            choiceLabel: "OpenRouter API key",
            choiceHint: "Via OpenRouter (openrouter.ai)",
            groupId: "arcee",
            groupLabel: "Arcee AI",
            groupHint: "Direct API or OpenRouter",
          },
        }),
      ],
      catalog: {
        run: async (ctx) => {
          const directKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (directKey) {
            return { provider: { ...buildArceeProvider(), apiKey: directKey } };
          }
          const orKey = ctx.resolveProviderApiKey("openrouter").apiKey;
          if (orKey) {
            return { provider: { ...buildArceeOpenRouterProvider(), apiKey: orKey } };
          }
          return null;
        },
      },
      augmentModelCatalog: ({ config }) =>
        readConfiguredProviderCatalogEntries({
          config,
          providerId: PROVIDER_ID,
        }),
      normalizeResolvedModel: ({ model }) =>
        isArceeOpenRouterBaseUrl(model.baseUrl)
          ? {
              ...model,
              id: toArceeOpenRouterModelId(model.id),
            }
          : undefined,
      ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
    });
  },
});
