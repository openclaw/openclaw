import type { ProviderResolveDynamicModelContext } from "openclaw/plugin-sdk/plugin-entry";
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  buildProviderReplayFamilyHooks,
  resolveFamilyForwardCompatModel,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import {
  FEATHERLESS_BASE_URL,
  FEATHERLESS_DEFAULT_MODEL_ID,
  FEATHERLESS_DYNAMIC_COMPAT,
  FEATHERLESS_DYNAMIC_CONTEXT_WINDOW,
  FEATHERLESS_DYNAMIC_MAX_TOKENS,
  isFeatherlessCatalogModelId,
} from "./models.js";
import { applyFeatherlessConnectionConfig, FEATHERLESS_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "featherless";

function resolveFeatherlessDynamicModel(ctx: ProviderResolveDynamicModelContext) {
  const modelId = ctx.modelId.trim();
  if (!modelId || isFeatherlessCatalogModelId(modelId)) {
    return undefined;
  }

  return resolveFamilyForwardCompatModel({
    providerId: PROVIDER_ID,
    modelId,
    ctx,
    cases: [
      {
        match: () => true,
        templateIds: [FEATHERLESS_DEFAULT_MODEL_ID],
        patch: ({ template }) =>
          template ? undefined : { api: "openai-completions", baseUrl: FEATHERLESS_BASE_URL },
      },
    ],
    patch: {
      provider: PROVIDER_ID,
      reasoning: false,
      input: ["text"],
      contextWindow: FEATHERLESS_DYNAMIC_CONTEXT_WINDOW,
      maxTokens: FEATHERLESS_DYNAMIC_MAX_TOKENS,
      compat: FEATHERLESS_DYNAMIC_COMPAT,
    },
    synthesize: true,
  });
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Featherless AI Provider",
  description: "Featherless AI provider plugin",
  manifest,
  provider: {
    label: "Featherless AI",
    docsPath: "/providers/featherless",
    manifestAuth: {
      defaultModel: FEATHERLESS_DEFAULT_MODEL_REF,
      applyConfig: applyFeatherlessConnectionConfig,
      noteTitle: "Featherless AI",
      noteMessage: [
        "Featherless AI serves open models through an OpenAI-compatible API.",
        "Create an API key at: https://featherless.ai/account/api-keys",
      ].join("\n"),
    },
    catalog: {
      discoveryMode: "strict",
      allowExplicitBaseUrl: true,
      liveModelDiscovery: {
        endpointPath: "models?capabilities=chat",
        buildRequestHeaders: ({ apiKey }) => ({
          Accept: "application/json",
          "User-Agent": "openclaw",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        }),
      },
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    normalizeResolvedModel: ({ model }) => ({
      ...model,
      compat: { ...FEATHERLESS_DYNAMIC_COMPAT, ...model.compat },
    }),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
    resolveDynamicModel: resolveFeatherlessDynamicModel,
    isModernModelRef: () => true,
  },
});
