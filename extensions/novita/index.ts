import {
  definePluginEntry,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { DEFAULT_CONTEXT_TOKENS } from "openclaw/plugin-sdk/provider-models";
import {
  ensureNovitaModelCache,
  getNovitaModelCapabilities,
  loadNovitaModelCapabilities,
} from "openclaw/plugin-sdk/provider-stream";
import { applyNovitaConfig, NOVITA_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildNovitaProvider, NOVITA_BASE_URL } from "./provider-catalog.js";

const PROVIDER_ID = "novita";
const NOVITA_DEFAULT_MAX_TOKENS = 8192;

function buildDynamicNovitaModel(ctx: ProviderResolveDynamicModelContext): ProviderRuntimeModel {
  const capabilities = getNovitaModelCapabilities(ctx.modelId);
  return {
    id: ctx.modelId,
    name: capabilities?.name ?? ctx.modelId,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: NOVITA_BASE_URL,
    reasoning: capabilities?.reasoning ?? false,
    input: capabilities?.input ?? ["text"],
    cost: capabilities?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: capabilities?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    maxTokens: capabilities?.maxTokens ?? NOVITA_DEFAULT_MAX_TOKENS,
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Novita AI Provider",
  description:
    "Bundled Novita AI provider plugin — 90+ models from DeepSeek, Qwen, MiniMax, Kimi, GLM, Llama, and more",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Novita AI",
      docsPath: "/providers/novita",
      envVars: ["NOVITA_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Novita AI API key",
          hint: "API key",
          optionKey: "novitaApiKey",
          flagName: "--novita-api-key",
          envVar: "NOVITA_API_KEY",
          promptMessage: "Enter Novita AI API key",
          defaultModel: NOVITA_DEFAULT_MODEL_REF,
          expectedProviders: [PROVIDER_ID],
          applyConfig: (cfg) => applyNovitaConfig(cfg),
          wizard: {
            choiceId: "novita-api-key",
            choiceLabel: "Novita AI API key",
            groupId: "novita",
            groupLabel: "Novita AI",
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
          // Populate cache layers: in-memory → disk → API fetch.
          // ensureNovitaModelCache is a no-op when already populated.
          ensureNovitaModelCache(apiKey);
          return {
            provider: {
              ...buildNovitaProvider(),
              apiKey,
            },
          };
        },
      },
      // Novita aggregates 90+ models from diverse vendors; disable strict
      // OpenAI-compat turn validation since upstream models may diverge.
      capabilities: {
        openAiCompatTurnValidation: false,
      },
      resolveDynamicModel: (ctx) => buildDynamicNovitaModel(ctx),
      prepareDynamicModel: async (ctx) => {
        // The catalog.run has already called ensureNovitaModelCache with the
        // API key, so the cache module has a stored key for background refreshes.
        // Fall back to process.env if catalog hasn't run yet.
        const apiKey = process.env.NOVITA_API_KEY ?? "";
        if (apiKey) {
          await loadNovitaModelCapabilities(ctx.modelId, apiKey);
        }
      },
      isModernModelRef: () => true,
    });
  },
});
