import {
  definePluginEntry,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { applyEdenaiConfig, EDENAI_DEFAULT_MODEL_REF } from "./onboard.js";
import {
  buildEdenaiProvider,
  buildStaticEdenaiProvider,
  EDENAI_BASE_URL,
  EDENAI_DYNAMIC_DEFAULTS,
  getEdenaiModelCapabilities,
  loadEdenaiModelCapabilities,
  normalizeEdenaiBaseUrl,
} from "./provider-catalog.js";

const PROVIDER_ID = "edenai";

// Eden AI's openai-compat surface proxies Google Gemini models; this hook
// shapes the replay path so Gemini thought signatures pass through cleanly.
// Same pattern OpenRouter, Kilocode, and OpenCode use, but called locally
// per the plugin-sdk deprecation note on PASSTHROUGH_GEMINI_REPLAY_HOOKS.
const EDENAI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "passthrough-gemini",
});

function buildDynamicEdenaiModel(ctx: ProviderResolveDynamicModelContext): ProviderRuntimeModel {
  const capabilities = getEdenaiModelCapabilities(ctx.modelId);
  return {
    id: ctx.modelId,
    name: capabilities?.name ?? ctx.modelId,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: EDENAI_BASE_URL,
    reasoning: capabilities?.reasoning ?? false,
    input: capabilities?.input
      ? capabilities.input.filter(
          (modality): modality is "image" | "text" => modality === "image" || modality === "text",
        )
      : ["text"],
    cost: capabilities?.cost ? { ...capabilities.cost } : { ...EDENAI_DYNAMIC_DEFAULTS.cost },
    contextWindow: capabilities?.contextWindow ?? EDENAI_DYNAMIC_DEFAULTS.contextWindow,
    maxTokens: capabilities?.maxTokens ?? EDENAI_DYNAMIC_DEFAULTS.maxTokens,
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Eden AI Provider",
  description: "Bundled Eden AI provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Eden AI",
      docsPath: "/providers/edenai",
      envVars: ["EDENAI_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Eden AI API key",
          hint: "API key",
          optionKey: "edenaiApiKey",
          flagName: "--edenai-api-key",
          envVar: "EDENAI_API_KEY",
          promptMessage: "Enter Eden AI API key",
          defaultModel: EDENAI_DEFAULT_MODEL_REF,
          expectedProviders: [PROVIDER_ID],
          applyConfig: (cfg) => applyEdenaiConfig(cfg),
          wizard: {
            choiceId: "edenai-api-key",
            choiceLabel: "Eden AI API key",
            groupId: "edenai",
            groupLabel: "Eden AI",
            groupHint: "API key",
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
          return {
            provider: {
              ...(await buildEdenaiProvider()),
              apiKey,
            },
          };
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({
          provider: buildStaticEdenaiProvider(),
        }),
      },
      resolveDynamicModel: (ctx) => buildDynamicEdenaiModel(ctx),
      prepareDynamicModel: async (ctx) => {
        await loadEdenaiModelCapabilities(ctx.modelId);
        if (!getEdenaiModelCapabilities(ctx.modelId)) {
          throw new Error(
            `Eden AI does not list "${ctx.modelId}" in its catalog. See https://app.edenai.run/models for valid model ids.`,
          );
        }
      },
      normalizeConfig: ({ providerConfig }) => {
        const normalizedBaseUrl = normalizeEdenaiBaseUrl(providerConfig.baseUrl);
        return normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl
          ? { ...providerConfig, baseUrl: normalizedBaseUrl }
          : undefined;
      },
      normalizeTransport: ({ api: transportApi, baseUrl }) => {
        const normalizedBaseUrl = normalizeEdenaiBaseUrl(baseUrl);
        return normalizedBaseUrl && normalizedBaseUrl !== baseUrl
          ? { api: transportApi, baseUrl: normalizedBaseUrl }
          : undefined;
      },
      ...EDENAI_REPLAY_HOOKS,
      isModernModelRef: () => true,
    });
  },
});
