import {
  canonicalizeMaxTokensParam,
  resolveMaxTokensParam,
  detectOpenAICompletionsCompat,
  resolveOpenAICompletionsCompat,
} from "@openclaw/ai/transports";
import {
  type NativeWebSearchToolPolicyParams,
  isNativeWebSearchAllowedByToolPolicy,
} from "../../agents/codex-native-web-search-core.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createGoogleThinkingPayloadWrapper } from "../../llm/providers/stream-wrappers/google.js";
import { createMinimaxThinkingDisabledWrapper } from "../../llm/providers/stream-wrappers/minimax.js";
import {
  createSiliconFlowThinkingWrapper,
  shouldApplySiliconFlowThinkingOffCompat,
} from "../../llm/providers/stream-wrappers/moonshot.js";
import {
  createOpenAICompletionsStrictMessageKeysWrapper,
  createOpenAICompletionsToolsCompatWrapper,
  createOpenAIResponsesContextManagementWrapper,
  createOpenAIStringContentWrapper,
} from "../../llm/providers/stream-wrappers/openai.js";
import { createOpenRouterSystemCacheWrapper } from "../../llm/providers/stream-wrappers/proxy.js";
import { streamWithPayloadPatch } from "../../llm/providers/stream-wrappers/stream-payload-utils.js";
import type { SimpleStreamOptions } from "../../llm/types.js";
import {
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  createThinkingOnlyFinalTextWrapper,
} from "../../plugin-sdk/provider-stream-shared.js";
import {
  ensureProviderRuntimePluginHandle,
  getModelProviderRuntimePluginHandle,
  type ProviderRuntimePluginHandle,
} from "../../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import type { ProviderPrepareExtraParamsContext } from "../../plugins/provider-runtime.types.js";
import {
  resolveAliasedParamValue,
  resolveModelExtraParamSources,
  sanitizeExtraParamsRecord,
} from "../model-extra-params.js";
import { createOpenAICompletionsPayloadPolicyWrapper } from "../openai-completions-payload-policy.js";
import type { AgentRuntimeTransport } from "../runtime-plan/types.js";
import type { StreamFn } from "../runtime/index.js";
import type { SettingsManager } from "../sessions/index.js";
import { log } from "./logger.js";
import { parseCacheRetention, resolveCacheRetention } from "./prompt-cache-retention.js";
import type { ProviderThinkLevel } from "./utils.js";

function requireBaseStreamFn(streamFn: StreamFn | undefined): StreamFn {
  if (!streamFn) {
    throw new Error("Cannot apply stream policy without a lifecycle-owned base stream.");
  }
  return streamFn;
}

const REQUEST_SCOPED_EXTRA_PARAM_KEYS = new Set(["response_format", "responseFormat", "stop"]);
const GPT_PARALLEL_TOOL_CALLS_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "openai-chatgpt-responses",
  "azure-openai-responses",
]);

export function resolveExtraParams(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  agentId?: string;
}): Record<string, unknown> | undefined {
  const { defaultParams, modelParams, agentModelParams, agentParams } =
    resolveModelExtraParamSources({
      config: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      agentId: params.agentId,
    });
  const sources = [defaultParams, modelParams, agentModelParams, agentParams];
  const merged = Object.assign({}, ...sources);
  canonicalizeExtraParamAlias(merged, sources, ["parallel_tool_calls", "parallelToolCalls"]);
  canonicalizeExtraParamAlias(
    merged,
    [modelParams, agentModelParams, agentParams],
    ["text_verbosity", "textVerbosity"],
  );
  canonicalizeExtraParamAlias(merged, sources, ["response_format", "responseFormat"]);
  canonicalizeMaxTokensParam({ merged, sources });
  canonicalizeExtraParamAlias(
    merged,
    sources,
    ["cached_content", "cachedContent"],
    "cachedContent",
  );
  if (params.provider === "openrouter") {
    canonicalizeOpenRouterResponseCacheParams(merged, sources);
  }

  applyDefaultOpenAIGptRuntimeParams(params, merged);

  return Object.keys(merged).length > 0 ? merged : undefined;
}

type CacheRetentionStreamOptions = SimpleStreamOptions & {
  cachedContent?: string;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
};
function resolveSupportedTransport(value: unknown): AgentRuntimeTransport | undefined {
  return value === "sse" ||
    value === "websocket" ||
    value === "websocket-cached" ||
    value === "auto"
    ? value
    : undefined;
}

export function resolvePreparedExtraParams(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  agentDir?: string;
  workspaceDir?: string;
  extraParamsOverride?: Record<string, unknown>;
  thinkingLevel?: ProviderThinkLevel;
  agentId?: string;
  resolvedExtraParams?: Record<string, unknown>;
  model?: ProviderRuntimeModel;
  resolvedTransport?: AgentRuntimeTransport;
  providerRuntimeHandle?: ProviderRuntimePluginHandle;
  auth?: ProviderPrepareExtraParamsContext["auth"];
}): Record<string, unknown> {
  const resolvedExtraParams =
    params.resolvedExtraParams ??
    resolveExtraParams({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      agentId: params.agentId,
    });
  const override = stripRequestScopedExtraParams(
    sanitizeExtraParamsOverride(params.extraParamsOverride),
  );
  const merged = {
    ...sanitizeExtraParamsRecord(resolvedExtraParams),
    ...override,
  };
  canonicalizeMaxTokensParam({
    merged,
    sources: [resolvedExtraParams, override],
  });
  canonicalizeExtraParamAlias(
    merged,
    [resolvedExtraParams, override],
    ["cached_content", "cachedContent"],
    "cachedContent",
  );
  if (params.provider === "openrouter") {
    canonicalizeOpenRouterResponseCacheParams(merged, [resolvedExtraParams, override]);
  }
  // Runtime plans memoize their own defaults. Results must not outlive the
  // prepared provider or share mutable hook output with another attempt.
  const { plugin } = ensureProviderRuntimePluginHandle({
    provider: params.provider,
    modelId: params.modelId,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    runtimeHandle:
      params.providerRuntimeHandle ?? getModelProviderRuntimePluginHandle(params.model),
  });
  const context = {
    config: params.cfg,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    provider: params.provider,
    modelId: params.modelId,
    model: params.model,
    thinkingLevel: params.thinkingLevel,
    auth: params.auth,
  };
  const prepared = plugin?.prepareExtraParams?.({ ...context, extraParams: merged }) ?? merged;
  const transportPatch = plugin?.extraParamsForTransport?.({
    ...context,
    extraParams: prepared,
    transport: params.resolvedTransport ?? resolveSupportedTransport(prepared.transport),
  })?.patch;
  const result = transportPatch ? { ...prepared, ...transportPatch } : prepared;
  canonicalizeMaxTokensParam({
    merged: result,
    sources: [prepared, transportPatch ?? undefined],
  });
  return result;
}

function sanitizeExtraParamsOverride(value: Record<string, unknown> | undefined) {
  return value && Object.keys(value).length > 0
    ? sanitizeExtraParamsRecord(
        Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)),
      )
    : undefined;
}

function stripRequestScopedExtraParams(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  const filtered = Object.fromEntries(
    Object.entries(value).filter(([key]) => !REQUEST_SCOPED_EXTRA_PARAM_KEYS.has(key)),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function hasRequestScopedExtraParams(value: Record<string, unknown>): boolean {
  return [...REQUEST_SCOPED_EXTRA_PARAM_KEYS].some((key) => Object.hasOwn(value, key));
}

function applyDefaultOpenAIGptRuntimeParams(
  params: { provider: string; modelId: string },
  merged: Record<string, unknown>,
): void {
  if (params.provider !== "openai" || !/^gpt-5(?:[.-]|$)/i.test(params.modelId)) {
    return;
  }
  if (
    !Object.hasOwn(merged, "parallel_tool_calls") &&
    !Object.hasOwn(merged, "parallelToolCalls")
  ) {
    merged.parallel_tool_calls = true;
  }
  if (!Object.hasOwn(merged, "text_verbosity") && !Object.hasOwn(merged, "textVerbosity")) {
    merged.text_verbosity = "low";
  }
}

export function resolveAgentTransportOverride(params: {
  settingsManager: Pick<SettingsManager, "getGlobalSettings" | "getProjectSettings">;
  effectiveExtraParams: Record<string, unknown> | undefined;
}): AgentRuntimeTransport | undefined {
  const globalSettings = params.settingsManager.getGlobalSettings();
  const projectSettings = params.settingsManager.getProjectSettings();
  if (Object.hasOwn(globalSettings, "transport") || Object.hasOwn(projectSettings, "transport")) {
    return undefined;
  }
  return resolveSupportedTransport(params.effectiveExtraParams?.transport);
}

export function resolveExplicitSettingsTransport(params: {
  settingsManager: Pick<SettingsManager, "getGlobalSettings" | "getProjectSettings">;
  sessionTransport: unknown;
}): AgentRuntimeTransport | undefined {
  const globalSettings = params.settingsManager.getGlobalSettings();
  const projectSettings = params.settingsManager.getProjectSettings();
  if (!Object.hasOwn(globalSettings, "transport") && !Object.hasOwn(projectSettings, "transport")) {
    return undefined;
  }
  return resolveSupportedTransport(params.sessionTransport);
}

function normalizeStopSequences(value: unknown): string[] | undefined {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
  if (!list) {
    return undefined;
  }
  const sequences = list.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return sequences.length > 0 ? sequences : undefined;
}

function createStreamFnWithExtraParams(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
  provider: string,
  model?: ProviderRuntimeModel,
): StreamFn | undefined {
  if (!extraParams || Object.keys(extraParams).length === 0) {
    return undefined;
  }

  if (
    Object.hasOwn(extraParams, "cacheRetention") &&
    parseCacheRetention(extraParams.cacheRetention) === undefined
  ) {
    // Provider params stay open-ended, so validate this shared knob at its consumer boundary.
    // Never echo the authored value: model params can contain sensitive custom data.
    log.warn('ignoring invalid cacheRetention param; expected "none", "short", or "long"');
  }

  const streamParams: CacheRetentionStreamOptions = {};
  if (typeof extraParams.temperature === "number") {
    streamParams.temperature = extraParams.temperature;
  }
  if (typeof extraParams.topP === "number") {
    streamParams.topP = extraParams.topP;
  }
  const maxTokens = resolveMaxTokensParam(extraParams);
  if (maxTokens !== undefined) {
    streamParams.maxTokens = maxTokens;
  }
  const resolvedResponseFormat = resolveAliasedParamValue(
    [extraParams],
    ["response_format", "responseFormat"],
  );
  if (
    resolvedResponseFormat &&
    typeof resolvedResponseFormat === "object" &&
    !Array.isArray(resolvedResponseFormat)
  ) {
    streamParams.responseFormat = resolvedResponseFormat as Record<string, unknown>;
  }
  const transport = resolveSupportedTransport(extraParams.transport);
  if (transport) {
    streamParams.transport = transport;
  } else if (extraParams.transport != null) {
    const transportSummary =
      typeof extraParams.transport === "string"
        ? extraParams.transport
        : typeof extraParams.transport;
    log.warn(`ignoring invalid transport param: ${transportSummary}`);
  }
  const cachedContent =
    typeof extraParams.cachedContent === "string"
      ? extraParams.cachedContent
      : typeof extraParams.cached_content === "string"
        ? extraParams.cached_content
        : undefined;
  if (typeof cachedContent === "string" && cachedContent.trim()) {
    streamParams.cachedContent = cachedContent.trim();
  }

  // Camel-case request overrides win over configured snake-case penalties.
  // Transports still decide which API accepts each sampling parameter.
  for (const keys of [
    ["frequencyPenalty", "frequency_penalty"],
    ["presencePenalty", "presence_penalty"],
  ] as const) {
    const value = resolveAliasedParamValue([extraParams], keys);
    if (typeof value === "number") {
      streamParams[keys[0]] = value;
    }
  }
  if (typeof extraParams.seed === "number") {
    streamParams.seed = extraParams.seed;
  }
  const resolvedStop = normalizeStopSequences(extraParams.stop);
  if (resolvedStop) {
    streamParams.stop = resolvedStop;
  }

  const readCacheCompat = (m?: ProviderRuntimeModel) =>
    m?.api === "openai-completions" ? resolveOpenAICompletionsCompat(m) : m?.compat;

  if (log.isEnabled("debug")) {
    const initialCacheRetention = resolveCacheRetention(
      extraParams,
      provider,
      typeof model?.api === "string" ? model.api : undefined,
      typeof model?.id === "string" ? model.id : undefined,
      readCacheCompat(model),
      model?.baseUrl,
    );
    if (Object.keys(streamParams).length > 0 || initialCacheRetention) {
      const debugParams = { ...streamParams, cacheRetention: initialCacheRetention };
      log.debug(`creating streamFn wrapper with params: ${JSON.stringify(debugParams)}`);
    }
  }

  const underlying = requireBaseStreamFn(baseStreamFn);
  return (callModel, context, options) => {
    const cacheRetention = resolveCacheRetention(
      extraParams,
      provider,
      typeof callModel.api === "string" ? callModel.api : undefined,
      typeof callModel.id === "string" ? callModel.id : undefined,
      readCacheCompat(callModel),
      callModel.baseUrl,
    );
    if (Object.keys(streamParams).length === 0 && !cacheRetention) {
      return underlying(callModel, context, options);
    }
    const effectiveCacheRetention = options?.cacheRetention ?? cacheRetention;
    return underlying(callModel, context, {
      ...streamParams,
      ...options,
      // Own undefined means no request override; explicit none/short/long still wins.
      ...(effectiveCacheRetention ? { cacheRetention: effectiveCacheRetention } : {}),
    });
  };
}

function canonicalizeExtraParamAlias(
  merged: Record<string, unknown>,
  sources: Array<Record<string, unknown> | undefined>,
  keys: readonly [string, string],
  canonical = keys[0],
): void {
  const resolved = resolveAliasedParamValue(sources, keys);
  if (resolved !== undefined) {
    merged[canonical] = resolved;
    delete merged[keys[0] === canonical ? keys[1] : keys[0]];
  }
}

const OPENROUTER_RESPONSE_CACHE_PARAM_ALIASES = [
  ["responseCache", "response_cache"],
  [
    "responseCacheTtlSeconds",
    "response_cache_ttl_seconds",
    "responseCacheTtl",
    "response_cache_ttl",
  ],
  ["responseCacheClear", "response_cache_clear"],
] as const;

function canonicalizeOpenRouterResponseCacheParams(
  merged: Record<string, unknown>,
  sources: Array<Record<string, unknown> | undefined>,
): void {
  for (const keys of OPENROUTER_RESPONSE_CACHE_PARAM_ALIASES) {
    const resolved = resolveAliasedParamValue(sources, keys);
    if (resolved === undefined) {
      continue;
    }
    for (const key of keys) {
      delete merged[key];
    }
    merged[keys[0]] = resolved;
  }
}

function createParallelToolCallsWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: boolean,
): StreamFn {
  const underlying = requireBaseStreamFn(baseStreamFn);
  return (model, context, options) => {
    if (!GPT_PARALLEL_TOOL_CALLS_APIS.has(model.api)) {
      return underlying(model, context, options);
    }
    log.debug(
      `applying parallel_tool_calls=${enabled} for ${model.provider ?? "unknown"}/${model.id ?? "unknown"} api=${model.api}`,
    );
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      payloadObj.parallel_tool_calls = enabled;
    });
  };
}

function normalizeDeepSeekV4CandidateId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = modelId.trim().toLowerCase();
  const suffixIndex = normalized.indexOf(":");
  const withoutSuffix = suffixIndex === -1 ? normalized : normalized.slice(0, suffixIndex);
  return withoutSuffix.split("/").pop();
}

function isDeepSeekV4OpenAICompletionsModel(model: Parameters<StreamFn>[0]): boolean {
  const normalizedModelId = normalizeDeepSeekV4CandidateId(model.id);
  return (
    model.api === "openai-completions" &&
    (normalizedModelId === "deepseek-flash" ||
      normalizedModelId === "deepseek-v4-flash" ||
      normalizedModelId === "deepseek-v4-pro")
  );
}

function isMicrosoftFoundryProviderId(provider: unknown): boolean {
  if (typeof provider !== "string") {
    return false;
  }
  const normalizedProvider = provider.trim().toLowerCase();
  return (
    normalizedProvider === "microsoft-foundry" ||
    normalizedProvider.startsWith("microsoft-foundry-")
  );
}

/**
 * Foundry and other non-native routes reject even thinking.type=disabled.
 * Explicit compat wins, then detected non-native formats; unknown proxy routes
 * retain the model-ID fallback to DeepSeek's native wire format.
 */
function deepSeekV4NativeThinkingAllowedByCompat(model: Parameters<StreamFn>[0]): boolean {
  const compat = (model as ProviderRuntimeModel).compat;
  const configured = compat && typeof compat === "object" ? compat.thinkingFormat : undefined;
  if (typeof configured === "string") {
    return configured === "deepseek";
  }
  const detected = detectOpenAICompletionsCompat(model as ProviderRuntimeModel).defaults
    .thinkingFormat;
  return detected !== "openrouter" && detected !== "together" && detected !== "zai";
}

function createDeepSeekV4NonNativeCompatSanitizerWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn | undefined {
  if (!baseStreamFn) {
    return undefined;
  }
  return (model, context, options) => {
    if (
      !isDeepSeekV4OpenAICompletionsModel(model) ||
      (!isMicrosoftFoundryProviderId(model.provider) &&
        deepSeekV4NativeThinkingAllowedByCompat(model))
    ) {
      return baseStreamFn(model, context, options);
    }
    return streamWithPayloadPatch(baseStreamFn, model, context, options, (payload) => {
      delete payload.thinking;
      if (Array.isArray(payload.messages)) {
        for (const message of payload.messages) {
          if (message && typeof message === "object") {
            delete (message as Record<string, unknown>).reasoning_content;
          }
        }
      }
    });
  };
}

const MIMO_REASONING_OPENAI_COMPATIBLE_MODEL_IDS = new Set([
  "mimo-v2-pro",
  "mimo-v2-omni",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  ...["flash", "pro", "pro-ultraspeed"].map((variant) => `mimo-v2.6-${variant}`),
]);
const MIMO_REASONING_AS_VISIBLE_TEXT_MODEL_IDS = new Set(["mimo-v2-pro", "mimo-v2-omni"]);

function isMiMoOpenAICompatibleModel(
  model: Parameters<StreamFn>[0],
  modelIds: ReadonlySet<string>,
): boolean {
  const normalizedModelId = normalizeDeepSeekV4CandidateId(model.id);
  return (
    model.api === "openai-completions" &&
    normalizedModelId !== undefined &&
    modelIds.has(normalizedModelId)
  );
}

export function applyExtraParamsToAgent(
  agent: { streamFn?: StreamFn },
  cfg: OpenClawConfig | undefined,
  provider: string,
  modelId: string,
  extraParamsOverride?: Record<string, unknown>,
  thinkingLevel?: ProviderThinkLevel,
  agentId?: string,
  workspaceDir?: string,
  model?: ProviderRuntimeModel,
  agentDir?: string,
  resolvedTransport?: AgentRuntimeTransport,
  options?: {
    preparedExtraParams?: Record<string, unknown>;
    auth?: ProviderPrepareExtraParamsContext["auth"];
    nativeWebSearchPolicyContext?: NativeWebSearchToolPolicyParams;
  },
) {
  const providerRuntimeHandle = ensureProviderRuntimePluginHandle({
    provider,
    modelId,
    config: cfg,
    workspaceDir,
    runtimeHandle: getModelProviderRuntimePluginHandle(model),
  });
  const override = sanitizeExtraParamsOverride(extraParamsOverride);
  const effectiveExtraParams =
    options?.preparedExtraParams ??
    resolvePreparedExtraParams({
      cfg,
      provider,
      modelId,
      extraParamsOverride,
      thinkingLevel,
      agentId,
      agentDir,
      workspaceDir,
      model,
      resolvedTransport,
      providerRuntimeHandle,
      auth: options?.auth,
    });
  const providerStreamBase = agent.streamFn;
  const nativeWebSearchAllowedByToolPolicy = options?.nativeWebSearchPolicyContext
    ? isNativeWebSearchAllowedByToolPolicy({
        config: cfg,
        modelProvider: model?.provider,
        modelId: model?.id,
        agentId,
        ...options.nativeWebSearchPolicyContext,
      })
    : undefined;
  const pluginWrappedStreamFn =
    providerRuntimeHandle.plugin?.wrapStreamFn?.({
      config: cfg,
      agentDir,
      workspaceDir,
      agentId,
      auth: options?.auth,
      nativeWebSearchAllowedByToolPolicy,
      provider,
      modelId,
      extraParams: effectiveExtraParams,
      thinkingLevel,
      model,
      streamFn: providerStreamBase,
    }) ?? undefined;
  agent.streamFn = pluginWrappedStreamFn ?? providerStreamBase;
  // Apply caller/config extra params outside provider defaults so explicit runtime
  // transport values can override provider-added defaults.
  const baseExtraParams =
    override && hasRequestScopedExtraParams(override)
      ? stripRequestScopedExtraParams(effectiveExtraParams)
      : effectiveExtraParams;
  const streamParams = override ? { ...baseExtraParams, ...override } : baseExtraParams;
  const wrappedStreamFn = createStreamFnWithExtraParams(
    agent.streamFn,
    streamParams,
    provider,
    model,
  );

  if (wrappedStreamFn) {
    log.debug(`applying extraParams to agent streamFn for ${provider}/${modelId}`);
    agent.streamFn = wrappedStreamFn;
  }

  if (
    shouldApplySiliconFlowThinkingOffCompat({
      provider,
      modelId,
      thinkingLevel,
    })
  ) {
    log.debug(
      `normalizing thinking=off to thinking=null for SiliconFlow compatibility (${provider}/${modelId})`,
    );
    agent.streamFn = createSiliconFlowThinkingWrapper(agent.streamFn);
  }
  const providerWrapperHandled =
    pluginWrappedStreamFn !== undefined && pluginWrappedStreamFn !== providerStreamBase;
  const cacheStreamParams = override
    ? { ...effectiveExtraParams, ...override }
    : effectiveExtraParams;
  agent.streamFn = createOpenRouterSystemCacheWrapper(agent.streamFn, cacheStreamParams);
  agent.streamFn = createOpenAIStringContentWrapper(agent.streamFn);
  agent.streamFn = createOpenAICompletionsStrictMessageKeysWrapper(agent.streamFn);
  agent.streamFn = createOpenAICompletionsToolsCompatWrapper(agent.streamFn);

  if (!providerWrapperHandled) {
    agent.streamFn = createDeepSeekV4OpenAICompatibleThinkingWrapper({
      baseStreamFn: agent.streamFn,
      thinkingLevel,
      shouldPatchModel: (candidateModel) =>
        isDeepSeekV4OpenAICompletionsModel(candidateModel) &&
        !isMicrosoftFoundryProviderId(candidateModel.provider) &&
        deepSeekV4NativeThinkingAllowedByCompat(candidateModel),
    });
    agent.streamFn = createDeepSeekV4NonNativeCompatSanitizerWrapper(agent.streamFn);

    // Unowned MiMo proxy routes bypass the Xiaomi hook but still need its
    // DeepSeek-style reasoning_content format for multi-turn tool calls.
    agent.streamFn = createDeepSeekV4OpenAICompatibleThinkingWrapper({
      baseStreamFn: agent.streamFn,
      thinkingLevel,
      shouldPatchModel: (candidateModel) =>
        isMiMoOpenAICompatibleModel(candidateModel, MIMO_REASONING_OPENAI_COMPATIBLE_MODEL_IDS),
    });
    // Legacy MiMo V2 can put final visible answers in reasoning_content. Apply
    // the response-side fallback here for custom Xiaomi-compatible proxy routes.
    agent.streamFn = createThinkingOnlyFinalTextWrapper({
      baseStreamFn: agent.streamFn,
      shouldPatchModel: (candidateModel) =>
        isMiMoOpenAICompatibleModel(candidateModel, MIMO_REASONING_AS_VISIBLE_TEXT_MODEL_IDS),
    });

    // Guard Google-family payloads against invalid negative thinking budgets
    // emitted by upstream model-ID heuristics for Gemini 3.1 variants.
    agent.streamFn = createGoogleThinkingPayloadWrapper(agent.streamFn, thinkingLevel);

    // Work around upstream shared model runtime hardcoding `store: false` for Responses API.
    // Force `store=true` for direct OpenAI Responses models and auto-enable
    // server-side compaction for compatible Responses payloads.
    agent.streamFn = createOpenAIResponsesContextManagementWrapper(
      agent.streamFn,
      effectiveExtraParams,
    );
  }

  // MiniMax's Anthropic-compatible stream can leak reasoning_content into the
  // visible reply path because it does not emit native Anthropic thinking
  // blocks. Disable thinking unless an earlier wrapper already set it.
  agent.streamFn = createMinimaxThinkingDisabledWrapper(agent.streamFn, thinkingLevel);

  agent.streamFn = createOpenAICompletionsPayloadPolicyWrapper(
    requireBaseStreamFn(agent.streamFn),
    [effectiveExtraParams, override],
  );

  const rawParallelToolCalls = resolveAliasedParamValue(
    [effectiveExtraParams, override],
    ["parallel_tool_calls", "parallelToolCalls"],
  );
  if (typeof rawParallelToolCalls === "boolean") {
    agent.streamFn = createParallelToolCallsWrapper(agent.streamFn, rawParallelToolCalls);
  } else if (rawParallelToolCalls === null) {
    log.debug("parallel_tool_calls suppressed by null override, skipping injection");
  } else if (rawParallelToolCalls !== undefined) {
    const summary =
      typeof rawParallelToolCalls === "string" ? rawParallelToolCalls : typeof rawParallelToolCalls;
    log.warn(`ignoring invalid parallel_tool_calls param: ${summary}`);
  }

  return { effectiveExtraParams, nativeWebSearchAllowedByToolPolicy };
}
