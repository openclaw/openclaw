import {
  definePluginEntry,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { DEFAULT_CONTEXT_TOKENS } from "openclaw/plugin-sdk/provider-model-shared";
import {
  getInworldModelCapabilities,
  INWORLD_COMPLETIONS_URL,
  INWORLD_DEFAULT_MODEL_REF,
  isInworldCacheTtlModel,
  toInworldWireModelId,
} from "./models.js";
import { applyInworldConfig } from "./onboard.js";
import { buildInworldProvider, buildStaticInworldProvider } from "./provider-catalog.js";
import { buildInworldSpeechProvider } from "./speech-provider.js";
import { resolveInworldThinkingProfile } from "./thinking-policy.js";

const PROVIDER_ID = "inworld";

function buildDynamicInworldModel(ctx: ProviderResolveDynamicModelContext): ProviderRuntimeModel {
  const capabilities = getInworldModelCapabilities(ctx.modelId);
  return {
    id: ctx.modelId,
    name: capabilities?.name ?? ctx.modelId,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: INWORLD_COMPLETIONS_URL,
    reasoning: capabilities?.reasoning ?? false,
    input: capabilities?.input?.filter(
      (m): m is "text" | "image" => m === "text" || m === "image",
    ) ?? ["text"],
    ...(capabilities?.compat ? { compat: capabilities.compat } : {}),
    cost: capabilities?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: capabilities?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    maxTokens: capabilities?.maxTokens ?? 8192,
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Inworld",
  description: "Bundled Inworld provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Inworld",
      docsPath: "/providers/inworld",
      envVars: ["INWORLD_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Inworld API key",
          hint: "API key",
          optionKey: "inworldApiKey",
          flagName: "--inworld-api-key",
          envVar: "INWORLD_API_KEY",
          promptMessage: "Enter Inworld API key",
          defaultModel: INWORLD_DEFAULT_MODEL_REF,
          expectedProviders: [PROVIDER_ID],
          applyConfig: (cfg) => applyInworldConfig(cfg),
          wizard: {
            choiceId: "inworld-api-key",
            choiceLabel: "Inworld API key",
            groupId: "inworld",
            groupLabel: "Inworld",
            groupHint: "API key",
            onboardingScopes: ["text-inference"],
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
              ...(await buildInworldProvider(apiKey)),
              apiKey,
            },
          };
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({ provider: buildStaticInworldProvider() }),
      },
      resolveDynamicModel: (ctx) => buildDynamicInworldModel(ctx),
      normalizeResolvedModel: ({ model }) => {
        const wireId = toInworldWireModelId(model.id);
        return wireId === model.id ? undefined : { ...model, id: wireId };
      },
      resolveThinkingProfile: ({ modelId }) => resolveInworldThinkingProfile(modelId),
      isCacheTtlEligible: (ctx) => isInworldCacheTtlModel(ctx.modelId),
      isModernModelRef: () => true,
    });

    api.registerSpeechProvider(buildInworldSpeechProvider());
  },
});
