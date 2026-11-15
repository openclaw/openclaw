import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-entry";
import {
  buildFamilyForwardCompatModel,
  matchesExactOrPrefix,
  normalizeProviderId,
} from "openclaw/plugin-sdk/provider-model-metadata";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
  ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildOpenAIUncataloguedModel,
  OPENAI_PRE_GPT5_MODEL_ID_PATTERN,
} from "./account-models.js";
import {
  classifyOpenAIBaseUrl,
  isOpenAICodexBaseUrl,
  isOpenAIApiBaseUrl,
  resolveOpenAIDefaultBaseUrl,
} from "./base-url.js";
import {
  applyOpenAIConfig,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_DEFAULT_MODEL,
} from "./default-models.js";
import { classifyOpenAiFailoverCode } from "./failover-code.js";
import {
  OPENAI_MANIFEST_PROVIDER,
  OPENAI_GPT_54_MAX_TOKENS,
  OPENAI_CHAT_LATEST_COST,
} from "./model-catalog-config.js";
import {
  buildOpenAIUnknownModelHint,
  OPENAI_CHAT_LATEST_MODEL_ID,
  OPENAI_DAYBREAK_MODEL_IDS,
  OPENAI_GPT_54_MODEL_ID,
  OPENAI_GPT_55_MODEL_ID,
  OPENAI_GPT_56_MODEL_ID,
  OPENAI_GPT_56_SOL_MODEL_ID,
  OPENAI_GPT_56_VARIANT_MODEL_IDS,
  OPENAI_GPT_6_MODEL_IDS,
  OPENAI_PROVIDER_MODERN_MODEL_IDS,
  isOpenAIPlatformOnlyRouteModelId,
  isOpenAISubscriptionOnlyRouteModelId,
  normalizeOpenAIModelRouteId,
} from "./model-route-contract.js";
import {
  buildOpenAIChatGPTAuthMethodRuns,
  buildOpenAICodexProviderHooks,
} from "./openai-chatgpt-provider.js";
import {
  buildOpenAIProviderCatalog,
  isCodexCatalogAuthMode,
  OPENAI_CATALOG_AUGMENTATIONS,
} from "./openai-provider-catalog.js";
import { createOpenAIProvider } from "./provider-contract-api.js";
import { resolveAuthoredOpenAIProviderConfig } from "./provider-policy-api.js";
import { buildOpenAIResponsesProviderHooks } from "./shared.js";
import { resolveUnifiedOpenAIThinkingProfile } from "./thinking-policy.js";
import { isSIWCAuthFlow, TOKEN_SHARING_AUTH_FLOW } from "./token-sharing.js";

const PROVIDER_ID = "openai";

function shouldUseOpenAIResponsesTransport(params: {
  provider: string;
  modelId?: string;
  api?: string | null;
  baseUrl?: string;
  config?: { models?: { providers?: Record<string, ModelProviderConfig | undefined> } };
}): boolean {
  if (params.api !== "openai-completions") {
    return false;
  }
  const isOwnerProvider = normalizeProviderId(params.provider) === PROVIDER_ID;
  const isPlatformEndpoint =
    typeof params.baseUrl === "string" && classifyOpenAIBaseUrl(params.baseUrl) === "platform";
  if (isOwnerProvider) {
    if (resolveAuthoredOpenAICompletionsRoute(params)) {
      return false;
    }
    return !params.baseUrl || isPlatformEndpoint;
  }
  return isPlatformEndpoint;
}

/** Authored Completions is a current transport contract; only catalog defaults are upgraded. */
function resolveAuthoredOpenAICompletionsRoute(params: {
  provider: string;
  modelId?: string;
  config?: { models?: { providers?: Record<string, ModelProviderConfig | undefined> } };
}): { api: "openai-completions"; baseUrl: string } | undefined {
  const providerConfig = resolveAuthoredOpenAIProviderConfig(params);
  if (!providerConfig) {
    return undefined;
  }
  const modelId = normalizeOpenAIModelRouteId(params.modelId);
  let modelConfig: ModelDefinitionConfig | undefined;
  for (const model of providerConfig.models ?? []) {
    if (normalizeOpenAIModelRouteId(model.id) !== modelId) {
      continue;
    }
    // Match config normalization: the first row stays authoritative while
    // later duplicate rows fill fields the first row omitted.
    modelConfig = modelConfig ? { ...model, ...modelConfig } : model;
  }
  const effectiveApi =
    normalizeOptionalString(modelConfig?.api) ?? normalizeOptionalString(providerConfig.api);
  if (effectiveApi !== "openai-completions") {
    return undefined;
  }
  const baseUrl =
    normalizeOptionalString(modelConfig?.baseUrl) ??
    normalizeOptionalString(providerConfig.baseUrl) ??
    resolveOpenAIDefaultBaseUrl(process.env);
  return { api: "openai-completions", baseUrl };
}

function shouldUseCodexResponsesHooks(params?: {
  api?: ProviderRuntimeModel["api"] | null;
  baseUrl?: string;
}): boolean {
  if (params?.api === "openai-chatgpt-responses") {
    return true;
  }
  return typeof params?.baseUrl === "string" && isOpenAICodexBaseUrl(params.baseUrl);
}

function shouldResolveDynamicModelThroughCodex(ctx: ProviderResolveDynamicModelContext): boolean {
  if (shouldUseCodexResponsesHooks(ctx.providerConfig)) {
    return true;
  }
  if (
    ctx.providerConfig?.api === "openai-responses" ||
    ctx.providerConfig?.api === "openai-completions" ||
    (ctx.providerConfig?.baseUrl && !isOpenAICodexBaseUrl(ctx.providerConfig.baseUrl))
  ) {
    return false;
  }
  // The auth planner owns profile ordering and projects the selected physical
  // route into providerConfig before materialization. Until then, only a
  // one-route model contract may choose a transport.
  if (isOpenAIPlatformOnlyRouteModelId(ctx.modelId)) {
    return false;
  }
  if (isOpenAISubscriptionOnlyRouteModelId(ctx.modelId)) {
    return true;
  }
  return ctx.agentRuntimeId === "codex";
}

const OPENAI_GPT_FORWARD_COMPAT_CASES = [
  {
    match: OPENAI_DAYBREAK_MODEL_IDS,
    templateIds: [OPENAI_GPT_56_SOL_MODEL_ID],
  },
  {
    match: OPENAI_GPT_6_MODEL_IDS,
    templateIds: [OPENAI_GPT_56_SOL_MODEL_ID, OPENAI_GPT_55_MODEL_ID],
  },
  {
    match: [OPENAI_CHAT_LATEST_MODEL_ID],
    templateIds: [OPENAI_GPT_55_MODEL_ID, OPENAI_GPT_54_MODEL_ID],
    patch: { reasoning: false, cost: OPENAI_CHAT_LATEST_COST, contextWindow: 400_000 },
  },
  {
    match: [OPENAI_GPT_56_MODEL_ID, ...OPENAI_GPT_56_VARIANT_MODEL_IDS],
    templateIds: [OPENAI_GPT_55_MODEL_ID],
  },
  {
    match: [OPENAI_GPT_55_MODEL_ID],
    templateIds: [OPENAI_GPT_55_MODEL_ID, OPENAI_GPT_54_MODEL_ID],
  },
  ...OPENAI_CATALOG_AUGMENTATIONS.map(({ id, templateIds }) => ({
    match: [id],
    templateIds,
  })),
] satisfies Parameters<typeof buildFamilyForwardCompatModel>[0]["cases"];

function resolveOpenAIGptForwardCompatModel(ctx: ProviderResolveDynamicModelContext) {
  const trimmedModelId = ctx.modelId.trim();
  const modelId = normalizeLowercaseStringOrEmpty(trimmedModelId);
  // Listings hide pre-GPT-5 families; refs selected in config or a session still resolve.
  if (OPENAI_PRE_GPT5_MODEL_ID_PATTERN.test(modelId)) {
    return {
      ...buildOpenAIUncataloguedModel(trimmedModelId, resolveOpenAIDefaultBaseUrl()),
      provider: PROVIDER_ID,
    };
  }
  const exactModel = ctx.modelRegistry.find(PROVIDER_ID, trimmedModelId);
  if (
    OPENAI_DAYBREAK_MODEL_IDS.some((id) => id === modelId) ||
    OPENAI_GPT_6_MODEL_IDS.some((id) => id === modelId) ||
    OPENAI_GPT_56_VARIANT_MODEL_IDS.some((id) => id === modelId)
  ) {
    if (exactModel) {
      return exactModel;
    }
  }
  // Known rows own capability metadata even before discovery. Only an exact registry row
  // may override compat; an older family template cannot choose this model's Code Mode tier.
  const catalogModel = OPENAI_MANIFEST_PROVIDER.models.find(
    ({ id }) => id === (modelId === OPENAI_GPT_56_MODEL_ID ? OPENAI_GPT_56_SOL_MODEL_ID : modelId),
  );
  return buildFamilyForwardCompatModel({
    providerId: PROVIDER_ID,
    ctx,
    cases: OPENAI_GPT_FORWARD_COMPAT_CASES,
    patch: {
      reasoning: true,
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
      ...catalogModel,
      id: trimmedModelId,
      name: trimmedModelId,
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: resolveOpenAIDefaultBaseUrl(),
      input: catalogModel
        ? catalogModel.input.filter(
            (item): item is "text" | "image" => item === "text" || item === "image",
          )
        : ["text", "image"],
      compat: exactModel ? exactModel.compat : catalogModel?.compat,
    },
    synthesize: true,
  });
}

export function buildOpenAIProvider(): ProviderPlugin {
  const providerDefinition = createOpenAIProvider();
  const apiKeyDefinition = providerDefinition.auth.find((method) => method.id === "api-key");
  if (!apiKeyDefinition) {
    throw new Error("OpenAI provider contract is missing API-key auth");
  }
  const chatGPTAuthRuns = buildOpenAIChatGPTAuthMethodRuns();
  const apiKeyRuntime = createProviderApiKeyAuthMethod({
    providerId: PROVIDER_ID,
    methodId: apiKeyDefinition.id,
    label: apiKeyDefinition.label,
    hint: apiKeyDefinition.hint,
    optionKey: "openaiApiKey",
    flagName: "--openai-api-key",
    envVar: "OPENAI_API_KEY",
    promptMessage: "Enter OpenAI API key",
    profileId: "openai:api-key",
    defaultModel: OPENAI_DEFAULT_MODEL,
    preserveExistingPrimary: true,
    expectedProviders: [PROVIDER_ID],
    applyConfig: (cfg) => applyOpenAIConfig(cfg),
    wizard: apiKeyDefinition.wizard,
  });
  for (const method of providerDefinition.auth) {
    if (method.id === "siwc") {
      method.starterModel = OPENAI_DEFAULT_MODEL;
      method.run = async (ctx) =>
        (await import("./token-sharing-oauth.runtime.js")).loginTokenSharing(ctx);
      continue;
    }
    if (method.id === "oauth" || method.id === "device-code") {
      method.starterModel = OPENAI_CODEX_DEFAULT_MODEL;
      method.run = chatGPTAuthRuns[method.id];
      continue;
    }
    if (method.id !== "api-key") {
      throw new Error(`OpenAI provider contract has unknown auth method: ${method.id}`);
    }
    method.starterModel = apiKeyRuntime.starterModel;
    method.run = apiKeyRuntime.run;
    method.runNonInteractive = apiKeyRuntime.runNonInteractive;
    method.validateNonInteractive = apiKeyRuntime.validateNonInteractive;
  }
  const codexHooks = buildOpenAICodexProviderHooks();
  const nativeResponsesHooks = buildOpenAIResponsesProviderHooks();
  const responsesHooks = buildOpenAIResponsesProviderHooks({ transport: "sse" });
  return {
    ...providerDefinition,
    ...buildOpenAIProviderCatalog(),
    resolveDynamicModel: (ctx) =>
      shouldResolveDynamicModelThroughCodex(ctx)
        ? codexHooks.resolveDynamicModel?.(ctx)
        : resolveOpenAIGptForwardCompatModel(ctx),
    preferRuntimeResolvedModel: (ctx) => codexHooks.preferRuntimeResolvedModel?.(ctx) ?? false,
    normalizeResolvedModel: (ctx) => {
      if (normalizeProviderId(ctx.provider ?? "") !== PROVIDER_ID) {
        return undefined;
      }
      const authoredCompletionsRoute = resolveAuthoredOpenAICompletionsRoute(ctx);
      if (authoredCompletionsRoute) {
        return { ...ctx.model, ...authoredCompletionsRoute };
      }
      if (shouldUseCodexResponsesHooks(ctx.model)) {
        return codexHooks.normalizeResolvedModel?.(ctx);
      }
      return shouldUseOpenAIResponsesTransport({
        ...ctx.model,
        modelId: ctx.modelId,
        config: ctx.config,
      })
        ? { ...ctx.model, api: "openai-responses" }
        : ctx.model;
    },
    normalizeTransport: (ctx) => {
      const authoredCompletionsRoute = resolveAuthoredOpenAICompletionsRoute(ctx);
      if (authoredCompletionsRoute) {
        return ctx.api === authoredCompletionsRoute.api &&
          ctx.baseUrl === authoredCompletionsRoute.baseUrl
          ? undefined
          : authoredCompletionsRoute;
      }
      if (shouldUseCodexResponsesHooks(ctx)) {
        return codexHooks.normalizeTransport?.(ctx);
      }
      return shouldUseOpenAIResponsesTransport(ctx)
        ? { api: "openai-responses", baseUrl: ctx.baseUrl }
        : undefined;
    },
    ...responsesHooks,
    prepareExtraParams: (ctx) => {
      if (ctx.auth?.mode === "oauth" && ctx.auth.authFlow === TOKEN_SHARING_AUTH_FLOW) {
        return {
          ...ctx.extraParams,
          transport: "sse",
          store: false,
          responsesServerCompaction: false,
        };
      }
      const providerConfig = ctx.config?.models?.providers?.[PROVIDER_ID];
      const useCodexTransport =
        shouldUseCodexResponsesHooks(ctx.model) ||
        (normalizeProviderId(ctx.provider) === PROVIDER_ID &&
          (!providerConfig?.baseUrl || isOpenAIApiBaseUrl(providerConfig.baseUrl)) &&
          isCodexCatalogAuthMode(providerConfig?.auth ?? ""));
      return (useCodexTransport ? nativeResponsesHooks : responsesHooks).prepareExtraParams?.(ctx);
    },
    resolveUsageAuth: codexHooks.resolveUsageAuth,
    fetchUsageSnapshot: codexHooks.fetchUsageSnapshot,
    refreshOAuth: async (credential) =>
      isSIWCAuthFlow(credential.authFlow)
        ? (await import("./token-sharing-oauth.runtime.js")).refreshTokenSharingCredential(
            credential,
          )
        : codexHooks.refreshOAuth(credential),
    buildUnknownModelHint: ({ modelId }) => buildOpenAIUnknownModelHint(modelId),
    buildMissingAuthMessage: (ctx) => {
      if (normalizeProviderId(ctx.provider) !== PROVIDER_ID) {
        return undefined;
      }
      if (ctx.listProfileIds(PROVIDER_ID).length === 0) {
        return undefined;
      }
      return `No API key found for provider "openai". You are authenticated with OpenAI ChatGPT/Codex OAuth. Use ${OPENAI_CODEX_DEFAULT_MODEL} with the ChatGPT/Codex OAuth profile, or set OPENAI_API_KEY for direct OpenAI API access.`;
    },
    matchesContextOverflowError: ({ errorMessage }) =>
      /content_filter.*(?:prompt|input).*(?:too long|exceed)/i.test(errorMessage),
    classifyFailoverReason: ({ code, errorMessage }) =>
      /^Provider (?:finish_reason|incomplete_reason): content_filter$/.test(errorMessage)
        ? "format"
        : classifyOpenAiFailoverCode(code),
    resolveReasoningOutputMode: () => "native",
    resolveThinkingProfile: ({ provider, modelId, agentRuntime, api, compat, thinkingLevelMap }) =>
      normalizeProviderId(provider) === PROVIDER_ID
        ? resolveUnifiedOpenAIThinkingProfile(modelId, agentRuntime, compat, api, thinkingLevelMap)
        : null,
    isModernModelRef: ({ modelId }) =>
      matchesExactOrPrefix(modelId, OPENAI_PROVIDER_MODERN_MODEL_IDS),
  };
}
