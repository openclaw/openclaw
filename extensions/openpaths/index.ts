import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  buildProviderReplayFamilyHooks,
  DEFAULT_CONTEXT_TOKENS,
} from "openclaw/plugin-sdk/provider-model-shared";
import { isOpenPathsAutoModelId } from "./models.js";
import { applyOpenPathsConfig, OPENPATHS_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildOpenPathsProvider, normalizeOpenPathsBaseUrl } from "./provider-catalog.js";

const PROVIDER_ID = "openpaths";
const OPENPATHS_DEFAULT_MAX_TOKENS = 8192;
const OPENPATHS_THINKING_LEVEL_IDS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function buildOpenPathsThinkingLevel(id: (typeof OPENPATHS_THINKING_LEVEL_IDS)[number]) {
  return { id };
}

const OPENPATHS_THINKING_PROFILE = {
  levels: OPENPATHS_THINKING_LEVEL_IDS.map(buildOpenPathsThinkingLevel),
  defaultLevel: "medium",
} satisfies ProviderThinkingProfile;

function resolveOpenPathsThinkingProfile(modelId: string): ProviderThinkingProfile | undefined {
  return isOpenPathsAutoModelId(modelId) ? OPENPATHS_THINKING_PROFILE : undefined;
}

function buildDynamicOpenPathsModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  if (!isOpenPathsAutoModelId(ctx.modelId)) {
    return undefined;
  }
  return {
    id: ctx.modelId,
    name: `OpenPaths ${ctx.modelId}`,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: "https://openpaths.io/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: OPENPATHS_DEFAULT_MAX_TOKENS,
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
      reasoningEffortMap: { xhigh: "high" },
      maxTokensField: "max_tokens",
    },
  };
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "OpenPaths Provider",
  description: "Bundled OpenPaths provider plugin",
  provider: {
    label: "OpenPaths",
    docsPath: "/providers/openpaths",
    aliases: ["openpath", "open-paths", "open-path"],
    auth: [
      {
        methodId: "api-key",
        label: "OpenPaths API key",
        hint: "API key",
        optionKey: "openpathsApiKey",
        flagName: "--openpaths-api-key",
        envVar: "OPENPATHS_API_KEY",
        promptMessage: "Enter OpenPaths API key",
        defaultModel: OPENPATHS_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyOpenPathsConfig(cfg),
        wizard: {
          choiceId: "openpaths-api-key",
          choiceLabel: "OpenPaths API key",
          groupId: "openpaths",
          groupLabel: "OpenPaths",
          groupHint: "API key",
        },
      },
    ],
    catalog: {
      buildProvider: buildOpenPathsProvider,
      allowExplicitBaseUrl: true,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    resolveDynamicModel: (ctx) => buildDynamicOpenPathsModel(ctx),
    normalizeConfig: ({ providerConfig }) => {
      const normalizedBaseUrl = normalizeOpenPathsBaseUrl(providerConfig.baseUrl);
      return normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl
        ? { ...providerConfig, baseUrl: normalizedBaseUrl }
        : undefined;
    },
    normalizeResolvedModel: ({ model }) => {
      const normalizedBaseUrl = normalizeOpenPathsBaseUrl(model.baseUrl);
      return normalizedBaseUrl && normalizedBaseUrl !== model.baseUrl
        ? { ...model, baseUrl: normalizedBaseUrl }
        : undefined;
    },
    normalizeTransport: ({ api, baseUrl }) => {
      const normalizedBaseUrl = normalizeOpenPathsBaseUrl(baseUrl);
      return normalizedBaseUrl && normalizedBaseUrl !== baseUrl
        ? {
            api,
            baseUrl: normalizedBaseUrl,
          }
        : undefined;
    },
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
    resolveReasoningOutputMode: () => "native",
    resolveThinkingProfile: ({ modelId }) => resolveOpenPathsThinkingProfile(modelId),
    isModernModelRef: ({ modelId }) => isOpenPathsAutoModelId(modelId),
  },
});
