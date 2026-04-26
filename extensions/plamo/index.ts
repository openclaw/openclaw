import type { ProviderResolveDynamicModelContext } from "openclaw/plugin-sdk/plugin-entry";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  buildProviderReplayFamilyHooks,
  cloneFirstTemplateModel,
  normalizeModelCompat,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOpenAICompatibleToolParameters } from "openclaw/plugin-sdk/provider-tools";
import {
  PLAMO_BASE_URL,
  PLAMO_DEFAULT_CONTEXT_WINDOW,
  PLAMO_DEFAULT_MAX_TOKENS,
  PLAMO_DEFAULT_MODEL_ID,
  PLAMO_MODEL_INPUT,
  PLAMO_OPENAI_COMPAT,
} from "./model-definitions.js";
import { applyPlamoConfig, PLAMO_DEFAULT_MODEL_REF } from "./onboard.js";
import {
  buildPlamoCatalog,
  hasConfiguredPlamoProviderAuth,
  PLAMO_REQUEST_AUTH_MARKER,
} from "./provider-catalog.js";
import { createPlamoToolCallWrapper, sanitizePlamoReplayHistory } from "./stream.js";

const PROVIDER_ID = "plamo";
const OPENAI_COMPATIBLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "openai-compatible",
});

function isPlamoModelId(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith("plamo-");
}

function resolvePlamoDynamicModel(ctx: ProviderResolveDynamicModelContext) {
  const modelId = ctx.modelId.trim();
  if (!modelId || !isPlamoModelId(modelId)) {
    return undefined;
  }

  return (
    cloneFirstTemplateModel({
      providerId: PROVIDER_ID,
      modelId,
      templateIds: [PLAMO_DEFAULT_MODEL_ID],
      ctx,
      patch: {
        provider: PROVIDER_ID,
        api: "openai-completions",
        reasoning: false,
      },
    }) ??
    normalizeModelCompat({
      id: modelId,
      name: modelId,
      provider: PROVIDER_ID,
      api: "openai-completions",
      baseUrl: ctx.providerConfig?.baseUrl ?? PLAMO_BASE_URL,
      reasoning: false,
      input: [...PLAMO_MODEL_INPUT],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: PLAMO_DEFAULT_CONTEXT_WINDOW,
      maxTokens: PLAMO_DEFAULT_MAX_TOKENS,
      compat: { ...PLAMO_OPENAI_COMPAT },
    })
  );
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Preferred Networks Provider",
  description: "Bundled Preferred Networks model provider plugin for PLaMo",
  provider: {
    label: "Preferred Networks",
    docsPath: "/providers/preferred-networks",
    auth: [
      {
        methodId: "api-key",
        label: "Preferred Networks API key",
        hint: "API key",
        optionKey: "plamoApiKey",
        flagName: "--plamo-api-key",
        envVar: "PLAMO_API_KEY",
        promptMessage: "Enter Preferred Networks API key",
        defaultModel: PLAMO_DEFAULT_MODEL_REF,
        applyConfig: applyPlamoConfig,
        wizard: {
          choiceId: "plamo-api-key",
          choiceLabel: "Preferred Networks API key",
          groupId: "plamo",
          groupLabel: "Preferred Networks",
          groupHint: "PLaMo API",
        },
      },
    ],
    catalog: {
      run: buildPlamoCatalog,
    },
    resolveSyntheticAuth: ({ providerConfig }) =>
      hasConfiguredPlamoProviderAuth(providerConfig)
        ? {
            apiKey: PLAMO_REQUEST_AUTH_MARKER,
            source: "models.providers.plamo.request (synthetic request auth)",
            mode: "api-key" as const,
          }
        : undefined,
    ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
    sanitizeReplayHistory: ({ messages }) => sanitizePlamoReplayHistory(messages),
    normalizeToolSchemas: ({ tools }) =>
      tools.map((tool) => ({
        ...tool,
        parameters: normalizeOpenAICompatibleToolParameters(
          tool.parameters,
        ) as typeof tool.parameters,
      })),
    resolveDynamicModel: (ctx) => resolvePlamoDynamicModel(ctx),
    isModernModelRef: ({ modelId }) => isPlamoModelId(modelId),
    createStreamFn: () => createPlamoToolCallWrapper(undefined),
  },
});
