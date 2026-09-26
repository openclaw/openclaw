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
/**
 * Resolves model extra parameters and transport overrides for embedded agents.
 */
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
import {
  createMiMoStrictReasoningTagsWrapper,
  normalizeReasoningFamilyModelId,
} from "./extra-params.mimo-reasoning.js";
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

/** True when a provider API accepts GPT parallel-tool-call payload settings. */
function supportsGptParallelToolCallsPayload(api: unknown): boolean {
  return typeof api === "string" && GPT_PARALLEL_TOOL_CALLS_APIS.has(api);
}

/**
 * Resolve provider-specific extra params from model config.
 * Used to pass through stream params like temperature/maxTokens.
 */
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

type CacheRetentionStreamOptions = Partial<SimpleStreamOptions> & {
  cacheRetention?: "none" | "short" | "long";
  cachedContent?: string;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  stop?: string[];
};
type SupportedTransport = AgentRuntimeTransport;

function resolveSupportedTransport(value: unknown): SupportedTransport | undefined {
  return value === "sse" ||
    value === "websocket" ||
    value === "websocket-cached" ||
    value === "auto"
    ? value
    : undefined;
}

function hasExplicitTransportSetting(settings: { transport?: unknown }): boolean {
  return Object.hasOwn(settings, "transport");
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
  resolvedTransport?: SupportedTransport;
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

function hasRequestScopedExtraParams(value: Record<string, unknown> | undefined): boolean {
  if (!value) {
    return false;
  }
  return [...REQUEST_SCOPED_EXTRA_PARAM_KEYS].some((key) => Object.hasOwn(value, key));
}

function shouldApplyDefaultOpenAIGptRuntimeParams(params: {
  provider: string;
  modelId: string;
}): boolean {
  if (params.provider !== "openai") {
    return false;
  }
  return /^gpt-5(?:[.-]|$)/i.test(params.modelId);
}

function applyDefaultOpenAIGptRuntimeParams(
  params: { provider: string; modelId: string },
  merged: Record<string, unknown>,
): void {
  if (!shouldApplyDefaultOpenAIGptRuntimeParams(params)) {
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
}): SupportedTransport | undefined {
  const globalSettings = params.settingsManager.getGlobalSettings();
  const projectSettings = params.settingsManager.getProjectSettings();
  if (hasExplicitTransportSetting(globalSettings) || hasExplicitTransportSetting(projectSettings)) {
    return undefined;
  }
  return resolveSupportedTransport(params.effectiveExtraParams?.transport);
}

export function resolveExplicitSettingsTransport(params: {
  settingsManager: Pick<SettingsManager, "getGlobalSettings" | "getProjectSettings">;
  sessionTransport: unknown;
}): SupportedTransport | undefined {
  const globalSettings = params.settingsManager.getGlobalSettings();
  const projectSettings = params.settingsManager.getProjectSettings();
  if (
    !hasExplicitTransportSetting(globalSettings) &&
    !hasExplicitTransportSetting(projectSettings)
  ) {
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

  // Resolve sampling / repetition params and add to streamParams
  // so transport layers can filter by API type (e.g. openai-responses skips penalty params).
  // Resolve aliased params: camelCase (runtime/request) checked first so
  // per-request gateway overrides take priority over configured snake_case values.
  const resolvedFrequencyPenalty = resolveAliasedParamValue(
    [extraParams],
    ["frequencyPenalty", "frequency_penalty"],
  );
  const resolvedPresencePenalty = resolveAliasedParamValue(
    [extraParams],
    ["presencePenalty", "presence_penalty"],
  );
  const resolvedSeed = extraParams.seed;
  if (typeof resolvedFrequencyPenalty === "number") {
    streamParams.frequencyPenalty = resolvedFrequencyPenalty;
  }
  if (typeof resolvedPresencePenalty === "number") {
    streamParams.presencePenalty = resolvedPresencePenalty;
  }
  if (typeof resolvedSeed === "number") {
    streamParams.seed = resolvedSeed;
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
  const wrappedStreamFn: StreamFn = (callModel, context, options) => {
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

  return wrappedStreamFn;
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
    if (!supportsGptParallelToolCallsPayload(model.api)) {
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

type ApplyExtraParamsContext = {
  agent: { streamFn?: StreamFn };
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  agentDir?: string;
  workspaceDir?: string;
  thinkingLevel?: ProviderThinkLevel;
  model?: ProviderRuntimeModel;
  effectiveExtraParams: Record<string, unknown>;
  resolvedExtraParams?: Record<string, unknown>;
  override?: Record<string, unknown>;
};

function applyPrePluginStreamWrappers(ctx: ApplyExtraParamsContext): void {
  const baseExtraParams =
    ctx.override && hasRequestScopedExtraParams(ctx.override)
      ? stripRequestScopedExtraParams(ctx.effectiveExtraParams)
      : ctx.effectiveExtraParams;
  const streamParams = ctx.override ? { ...baseExtraParams, ...ctx.override } : baseExtraParams;
  const wrappedStreamFn = createStreamFnWithExtraParams(
    ctx.agent.streamFn,
    streamParams,
    ctx.provider,
    ctx.model,
  );

  if (wrappedStreamFn) {
    log.debug(`applying extraParams to agent streamFn for ${ctx.provider}/${ctx.modelId}`);
    ctx.agent.streamFn = wrappedStreamFn;
  }

  if (
    shouldApplySiliconFlowThinkingOffCompat({
      provider: ctx.provider,
      modelId: ctx.modelId,
      thinkingLevel: ctx.thinkingLevel,
    })
  ) {
    log.debug(
      `normalizing thinking=off to thinking=null for SiliconFlow compatibility (${ctx.provider}/${ctx.modelId})`,
    );
    ctx.agent.streamFn = createSiliconFlowThinkingWrapper(ctx.agent.streamFn);
  }
}

function applyPostPluginStreamWrappers(
  ctx: ApplyExtraParamsContext & { providerWrapperHandled: boolean },
): void {
  const streamParams = ctx.override
    ? { ...ctx.effectiveExtraParams, ...ctx.override }
    : ctx.effectiveExtraParams;
  ctx.agent.streamFn = createOpenRouterSystemCacheWrapper(ctx.agent.streamFn, streamParams);
  ctx.agent.streamFn = createOpenAIStringContentWrapper(ctx.agent.streamFn);
  ctx.agent.streamFn = createOpenAICompletionsStrictMessageKeysWrapper(ctx.agent.streamFn);
  ctx.agent.streamFn = createOpenAICompletionsToolsCompatWrapper(ctx.agent.streamFn);

  if (!ctx.providerWrapperHandled) {
    ctx.agent.streamFn = createDeepSeekV4OpenAICompatibleThinkingWrapper({
      baseStreamFn: ctx.agent.streamFn,
      thinkingLevel: ctx.thinkingLevel,
      shouldPatchModel: (model) =>
        isDeepSeekV4OpenAICompatibleModel(model) && deepSeekV4NativeThinkingAllowedByCompat(model),
    });
    ctx.agent.streamFn = createDeepSeekV4NonNativeCompatSanitizerWrapper(ctx.agent.streamFn);

    // MiMo reasoning models use the same DeepSeek-style reasoning_content wire
    // format. When MiMo is reached through an unowned proxy/custom provider
    // (e.g. `xiaomi-orbit` pointed at token-plan-*.xiaomimimo.com), the bundled
    // xiaomi plugin's wrapStreamFn does not fire, so apply the shared wrapper
    // here as a fallback so multi-turn tool calls succeed.
    ctx.agent.streamFn = createDeepSeekV4OpenAICompatibleThinkingWrapper({
      baseStreamFn: ctx.agent.streamFn,
      thinkingLevel: ctx.thinkingLevel,
      shouldPatchModel: isMiMoReasoningOpenAICompatibleModel,
    });
    // Legacy MiMo V2 can put final visible answers in reasoning_content. Apply
    // the response-side fallback here for custom Xiaomi-compatible proxy routes.
    ctx.agent.streamFn = createThinkingOnlyFinalTextWrapper({
      baseStreamFn: ctx.agent.streamFn,
      shouldPatchModel: isMiMoReasoningAsVisibleTextOpenAICompatibleModel,
    });
    // vLLM mimo-parser endpoints can leak inline `<think>` thinking into visible
    // content with the closer absorbed; hidden at each flush boundary for MiMo
    // v2.5+ so reasoning-visibility toggles stay authoritative (issue #156803).
    ctx.agent.streamFn = createMiMoStrictReasoningTagsWrapper(ctx.agent.streamFn);

    // Guard Google-family payloads against invalid negative thinking budgets
    // emitted by upstream model-ID heuristics for Gemini 3.1 variants.
    ctx.agent.streamFn = createGoogleThinkingPayloadWrapper(ctx.agent.streamFn, ctx.thinkingLevel);

    // Work around upstream shared model runtime hardcoding `store: false` for Responses API.
    // Force `store=true` for direct OpenAI Responses models and auto-enable
    // server-side compaction for compatible Responses payloads.
    ctx.agent.streamFn = createOpenAIResponsesContextManagementWrapper(
      ctx.agent.streamFn,
      ctx.effectiveExtraParams,
    );
  }

  // MiniMax's Anthropic-compatible stream can leak reasoning_content into the
  // visible reply path because it does not emit native Anthropic thinking
  // blocks. Disable thinking unless an earlier wrapper already set it.
  ctx.agent.streamFn = createMinimaxThinkingDisabledWrapper(ctx.agent.streamFn, ctx.thinkingLevel);

  ctx.agent.streamFn = createOpenAICompletionsPayloadPolicyWrapper(
    requireBaseStreamFn(ctx.agent.streamFn),
    [ctx.effectiveExtraParams, ctx.override],
  );

  const rawParallelToolCalls = resolveAliasedParamValue(
    [ctx.effectiveExtraParams, ctx.override],
    ["parallel_tool_calls", "parallelToolCalls"],
  );
  if (rawParallelToolCalls === undefined) {
    return;
  }
  if (typeof rawParallelToolCalls === "boolean") {
    ctx.agent.streamFn = createParallelToolCallsWrapper(ctx.agent.streamFn, rawParallelToolCalls);
    return;
  }
  if (rawParallelToolCalls === null) {
    log.debug("parallel_tool_calls suppressed by null override, skipping injection");
    return;
  }
  const summary =
    typeof rawParallelToolCalls === "string" ? rawParallelToolCalls : typeof rawParallelToolCalls;
  log.warn(`ignoring invalid parallel_tool_calls param: ${summary}`);
}

function isDeepSeekV4OpenAICompatibleModel(model: Parameters<StreamFn>[0]): boolean {
  return isDeepSeekV4OpenAICompletionsModel(model) && !isMicrosoftFoundryProviderId(model.provider);
}

function isDeepSeekV4OpenAICompletionsModel(model: Parameters<StreamFn>[0]): boolean {
  const normalizedModelId = normalizeReasoningFamilyModelId(model.id);
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
 * The DeepSeek V4 wrapper emits the deepseek-native `thinking: { type }` wire
 * format (plus `reasoning_effort`). Honor an explicit `compat.thinkingFormat`
 * override that selects a different reasoning format: some OpenAI-compatible
 * deployments — notably Azure AI Foundry DeepSeek V4 — reject the `thinking`
 * parameter outright, even `thinking: { type: "disabled" }`. When no override
 * exists, honor provider-level detection for non-native formats such as
 * OpenRouter while keeping id-based fallback for unknown DeepSeek-compatible
 * proxy routes.
 */
function deepSeekV4NativeThinkingAllowedByCompat(model: Parameters<StreamFn>[0]): boolean {
  const thinkingFormat = resolveDeepSeekV4ThinkingFormatOverride(model);
  return thinkingFormat === undefined || thinkingFormat === "deepseek";
}

function resolveDeepSeekV4ThinkingFormatOverride(
  model: Parameters<StreamFn>[0],
): string | undefined {
  const compat = (model as ProviderRuntimeModel).compat;
  const configured = compat && typeof compat === "object" ? compat.thinkingFormat : undefined;
  if (typeof configured === "string") {
    return configured;
  }
  const detected = detectOpenAICompletionsCompat(model as ProviderRuntimeModel).defaults
    .thinkingFormat;
  return detected === "openrouter" || detected === "together" || detected === "zai"
    ? detected
    : undefined;
}

function createDeepSeekV4NonNativeCompatSanitizerWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn | undefined {
  if (!baseStreamFn) {
    return undefined;
  }
  return (model, context, options) => {
    if (!shouldSanitizeDeepSeekV4NonNativeFields(model)) {
      return baseStreamFn(model, context, options);
    }
    return streamWithPayloadPatch(baseStreamFn, model, context, options, (payload) => {
      delete payload.thinking;
      stripDeepSeekV4ReasoningContent(payload);
    });
  };
}

function shouldSanitizeDeepSeekV4NonNativeFields(model: Parameters<StreamFn>[0]): boolean {
  return (
    isDeepSeekV4OpenAICompletionsModel(model) &&
    (isMicrosoftFoundryProviderId(model.provider) ||
      !deepSeekV4NativeThinkingAllowedByCompat(model))
  );
}

function stripDeepSeekV4ReasoningContent(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.messages)) {
    return;
  }
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    delete (message as Record<string, unknown>).reasoning_content;
  }
}

const MIMO_REASONING_OPENAI_COMPATIBLE_MODEL_IDS = new Set([
  "mimo-v2-pro",
  "mimo-v2-omni",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  ...["flash", "pro", "pro-ultraspeed"].map((variant) => `mimo-v2.6-${variant}`),
]);
const MIMO_REASONING_AS_VISIBLE_TEXT_MODEL_IDS = new Set(["mimo-v2-pro", "mimo-v2-omni"]);

function isMiMoReasoningOpenAICompatibleModel(model: Parameters<StreamFn>[0]): boolean {
  const normalizedModelId = normalizeReasoningFamilyModelId(model.id);
  return (
    model.api === "openai-completions" &&
    normalizedModelId !== undefined &&
    MIMO_REASONING_OPENAI_COMPATIBLE_MODEL_IDS.has(normalizedModelId)
  );
}

function isMiMoReasoningAsVisibleTextOpenAICompatibleModel(
  model: Parameters<StreamFn>[0],
): boolean {
  const normalizedModelId = normalizeReasoningFamilyModelId(model.id);
  return (
    model.api === "openai-completions" &&
    normalizedModelId !== undefined &&
    MIMO_REASONING_AS_VISIBLE_TEXT_MODEL_IDS.has(normalizedModelId)
  );
}

/**
 * Apply extra params (like temperature) to an agent's streamFn.
 * Also applies verified provider-specific request wrappers, such as OpenRouter attribution.
 */
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
  resolvedTransport?: SupportedTransport,
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
  const resolvedExtraParams = resolveExtraParams({
    cfg,
    provider,
    modelId,
    agentId,
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
      resolvedExtraParams,
      model,
      resolvedTransport,
      providerRuntimeHandle,
      auth: options?.auth,
    });
  const wrapperContext: ApplyExtraParamsContext = {
    agent,
    cfg,
    provider,
    modelId,
    agentDir,
    workspaceDir,
    thinkingLevel,
    model,
    effectiveExtraParams,
    resolvedExtraParams,
    override,
  };

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
  applyPrePluginStreamWrappers(wrapperContext);
  const providerWrapperHandled =
    pluginWrappedStreamFn !== undefined && pluginWrappedStreamFn !== providerStreamBase;
  applyPostPluginStreamWrappers({
    ...wrapperContext,
    providerWrapperHandled,
  });

  return { effectiveExtraParams, nativeWebSearchAllowedByToolPolicy };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
