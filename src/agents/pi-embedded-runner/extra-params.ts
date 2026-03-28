import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { AgentStreamParams } from "../../commands/agent/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  prepareProviderExtraParams as prepareProviderExtraParamsRuntime,
  wrapProviderStreamFn as wrapProviderStreamFnRuntime,
} from "../../plugins/provider-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/types.js";
import { normalizeToolName } from "../tool-policy.js";
import {
  createAnthropicBetaHeadersWrapper,
  createAnthropicFastModeWrapper,
  createAnthropicToolPayloadCompatibilityWrapper,
  resolveAnthropicFastMode,
  resolveAnthropicBetas,
  resolveCacheRetention,
} from "./anthropic-stream-wrappers.js";
import { createBedrockNoCacheWrapper, isAnthropicBedrockModel } from "./bedrock-stream-wrappers.js";
import { createGoogleThinkingPayloadWrapper } from "./google-stream-wrappers.js";
import { log } from "./logger.js";
import { createMinimaxFastModeWrapper } from "./minimax-stream-wrappers.js";
import {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
  createSiliconFlowThinkingWrapper,
  shouldApplyMoonshotPayloadCompat,
  shouldApplySiliconFlowThinkingOffCompat,
} from "./moonshot-stream-wrappers.js";
import {
  createOpenAIAttributionHeadersWrapper,
  createOpenAIDefaultTransportWrapper,
  createOpenAIFastModeWrapper,
  createOpenAIResponsesContextManagementWrapper,
  createOpenAIServiceTierWrapper,
  resolveOpenAIFastMode,
  resolveOpenAIServiceTier,
} from "./openai-stream-wrappers.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

const defaultProviderRuntimeDeps = {
  prepareProviderExtraParams: prepareProviderExtraParamsRuntime,
  wrapProviderStreamFn: wrapProviderStreamFnRuntime,
};

const providerRuntimeDeps = {
  ...defaultProviderRuntimeDeps,
};

export const __testing = {
  setProviderRuntimeDepsForTest(
    deps: Partial<typeof defaultProviderRuntimeDeps> | undefined,
  ): void {
    providerRuntimeDeps.prepareProviderExtraParams =
      deps?.prepareProviderExtraParams ?? defaultProviderRuntimeDeps.prepareProviderExtraParams;
    providerRuntimeDeps.wrapProviderStreamFn =
      deps?.wrapProviderStreamFn ?? defaultProviderRuntimeDeps.wrapProviderStreamFn;
  },
  resetProviderRuntimeDepsForTest(): void {
    providerRuntimeDeps.prepareProviderExtraParams =
      defaultProviderRuntimeDeps.prepareProviderExtraParams;
    providerRuntimeDeps.wrapProviderStreamFn = defaultProviderRuntimeDeps.wrapProviderStreamFn;
  },
};

/**
 * Resolve provider-specific extra params from model config.
 * Used to pass through stream params like temperature/maxTokens.
 *
 * @internal Exported for testing only
 */
export function resolveExtraParams(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  agentId?: string;
}): Record<string, unknown> | undefined {
  const modelKey = `${params.provider}/${params.modelId}`;
  const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
  const globalParams = modelConfig?.params ? { ...modelConfig.params } : undefined;
  const agentParams =
    params.agentId && params.cfg?.agents?.list
      ? params.cfg.agents.list.find((agent) => agent.id === params.agentId)?.params
      : undefined;

  if (!globalParams && !agentParams) {
    return undefined;
  }

  const merged = Object.assign({}, globalParams, agentParams);
  const resolvedParallelToolCalls = resolveAliasedParamValue(
    [globalParams, agentParams],
    "parallel_tool_calls",
    "parallelToolCalls",
  );
  if (resolvedParallelToolCalls !== undefined) {
    merged.parallel_tool_calls = resolvedParallelToolCalls;
    delete merged.parallelToolCalls;
  }

  return merged;
}

type CacheRetentionStreamOptions = Partial<SimpleStreamOptions> & {
  cacheRetention?: "none" | "short" | "long";
  openaiWsWarmup?: boolean;
  toolChoice?: NonNullable<AgentStreamParams["toolChoice"]>;
};
type SupportedTransport = Exclude<CacheRetentionStreamOptions["transport"], undefined>;
type ToolChoiceOverride = NonNullable<AgentStreamParams["toolChoice"]>;

function isToolChoiceOverride(value: unknown): value is ToolChoiceOverride {
  if (value === "auto" || value === "none" || value === "required") {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const fn = record.function;
  return (
    record.type === "function" &&
    !!fn &&
    typeof fn === "object" &&
    typeof (fn as Record<string, unknown>).name === "string"
  );
}

function resolveAllowedToolChoiceName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | undefined {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return undefined;
  }
  const trimmed = rawName.trim();
  if (!trimmed) {
    return undefined;
  }
  if (allowedToolNames.has(trimmed)) {
    return trimmed;
  }
  const normalized = normalizeToolName(trimmed);
  if (allowedToolNames.has(normalized)) {
    return normalized;
  }
  const lowered = normalized.toLowerCase();
  let caseInsensitiveMatch: string | undefined;
  for (const candidate of allowedToolNames) {
    if (candidate.toLowerCase() !== lowered) {
      continue;
    }
    if (caseInsensitiveMatch && caseInsensitiveMatch !== candidate) {
      return undefined;
    }
    caseInsensitiveMatch = candidate;
  }
  return caseInsensitiveMatch;
}

function sanitizeToolChoiceOverride(
  extraParams: Record<string, unknown> | undefined,
  allowedToolNames?: Set<string>,
): Record<string, unknown> | undefined {
  if (!extraParams || !isToolChoiceOverride(extraParams.toolChoice)) {
    return extraParams;
  }
  if (!allowedToolNames || allowedToolNames.size === 0) {
    if (extraParams.toolChoice === "none") {
      return extraParams;
    }
    return {
      ...extraParams,
      toolChoice: "none",
    };
  }
  const toolChoice = extraParams.toolChoice;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return extraParams;
  }
  const resolvedName = resolveAllowedToolChoiceName(toolChoice.function.name, allowedToolNames);
  if (!resolvedName) {
    return {
      ...extraParams,
      toolChoice: "auto",
    };
  }
  if (resolvedName === toolChoice.function.name) {
    return extraParams;
  }
  return {
    ...extraParams,
    toolChoice: {
      type: "function",
      function: {
        name: resolvedName,
      },
    },
  };
}

function resolveSupportedTransport(value: unknown): SupportedTransport | undefined {
  return value === "sse" || value === "websocket" || value === "auto" ? value : undefined;
}

function hasExplicitTransportSetting(settings: { transport?: unknown }): boolean {
  return Object.hasOwn(settings, "transport");
}

export function resolvePreparedExtraParams(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  extraParamsOverride?: Record<string, unknown>;
  thinkingLevel?: ThinkLevel;
  agentId?: string;
  resolvedExtraParams?: Record<string, unknown>;
}): Record<string, unknown> {
  const resolvedExtraParams =
    params.resolvedExtraParams ??
    resolveExtraParams({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      agentId: params.agentId,
    });
  const override =
    params.extraParamsOverride && Object.keys(params.extraParamsOverride).length > 0
      ? sanitizeExtraParamsRecord(
          Object.fromEntries(
            Object.entries(params.extraParamsOverride).filter(([, value]) => value !== undefined),
          ),
        )
      : undefined;
  const merged = {
    ...sanitizeExtraParamsRecord(resolvedExtraParams),
    ...override,
  };
  return (
    providerRuntimeDeps.prepareProviderExtraParams({
      provider: params.provider,
      config: params.cfg,
      context: {
        config: params.cfg,
        provider: params.provider,
        modelId: params.modelId,
        extraParams: merged,
        thinkingLevel: params.thinkingLevel,
      },
    }) ?? merged
  );
}

function sanitizeExtraParamsRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => key !== "__proto__" && key !== "prototype" && key !== "constructor",
    ),
  );
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

function createStreamFnWithExtraParams(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): StreamFn | undefined {
  if (!extraParams || Object.keys(extraParams).length === 0) {
    return undefined;
  }

  const streamParams: CacheRetentionStreamOptions = {};
  if (typeof extraParams.temperature === "number") {
    streamParams.temperature = extraParams.temperature;
  }
  if (typeof extraParams.maxTokens === "number") {
    streamParams.maxTokens = extraParams.maxTokens;
  }
  if (isToolChoiceOverride(extraParams.toolChoice)) {
    streamParams.toolChoice = extraParams.toolChoice;
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
  if (typeof extraParams.openaiWsWarmup === "boolean") {
    streamParams.openaiWsWarmup = extraParams.openaiWsWarmup;
  }
  const cacheRetention = resolveCacheRetention(extraParams, provider);
  if (cacheRetention) {
    streamParams.cacheRetention = cacheRetention;
  }

  if (Object.keys(streamParams).length === 0) {
    return undefined;
  }

  log.debug(`creating streamFn wrapper with params: ${JSON.stringify(streamParams)}`);

  const underlying = baseStreamFn ?? streamSimple;
  const wrappedStreamFn: StreamFn = (model, context, options) => {
    return underlying(model, context, {
      ...streamParams,
      ...options,
    });
  };

  return wrappedStreamFn;
}

function resolveAliasedParamValue(
  sources: Array<Record<string, unknown> | undefined>,
  snakeCaseKey: string,
  camelCaseKey: string,
): unknown {
  let resolved: unknown = undefined;
  let seen = false;
  for (const source of sources) {
    if (!source) {
      continue;
    }
    const hasSnakeCaseKey = Object.hasOwn(source, snakeCaseKey);
    const hasCamelCaseKey = Object.hasOwn(source, camelCaseKey);
    if (!hasSnakeCaseKey && !hasCamelCaseKey) {
      continue;
    }
    resolved = hasSnakeCaseKey ? source[snakeCaseKey] : source[camelCaseKey];
    seen = true;
  }
  return seen ? resolved : undefined;
}

function createParallelToolCallsWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.api !== "openai-completions" && model.api !== "openai-responses") {
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
  workspaceDir?: string;
  thinkingLevel?: ThinkLevel;
  model?: ProviderRuntimeModel;
  effectiveExtraParams: Record<string, unknown>;
  sanitizedExtraParams: Record<string, unknown>;
  resolvedExtraParams?: Record<string, unknown>;
  override?: Record<string, unknown>;
};

function applyPrePluginStreamWrappers(ctx: ApplyExtraParamsContext): void {
  if (ctx.provider === "openai" || ctx.provider === "openai-codex") {
    if (ctx.provider === "openai") {
      // Default OpenAI Responses to WebSocket-first with transparent SSE fallback.
      ctx.agent.streamFn = createOpenAIDefaultTransportWrapper(ctx.agent.streamFn);
    }
    ctx.agent.streamFn = createOpenAIAttributionHeadersWrapper(ctx.agent.streamFn);
  }

  const wrappedStreamFn = createStreamFnWithExtraParams(
    ctx.agent.streamFn,
    ctx.sanitizedExtraParams,
    ctx.provider,
  );

  if (wrappedStreamFn) {
    log.debug(`applying extraParams to agent streamFn for ${ctx.provider}/${ctx.modelId}`);
    ctx.agent.streamFn = wrappedStreamFn;
  }

  const anthropicBetas = resolveAnthropicBetas(ctx.sanitizedExtraParams, ctx.provider, ctx.modelId);
  if (anthropicBetas?.length) {
    log.debug(
      `applying Anthropic beta header for ${ctx.provider}/${ctx.modelId}: ${anthropicBetas.join(",")}`,
    );
    ctx.agent.streamFn = createAnthropicBetaHeadersWrapper(ctx.agent.streamFn, anthropicBetas);
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

  ctx.agent.streamFn = createAnthropicToolPayloadCompatibilityWrapper(ctx.agent.streamFn, {
    config: ctx.cfg,
    workspaceDir: ctx.workspaceDir,
  });
}

function applyPostPluginStreamWrappers(
  ctx: ApplyExtraParamsContext & { providerWrapperHandled: boolean },
): void {
  if (
    !ctx.providerWrapperHandled &&
    shouldApplyMoonshotPayloadCompat({ provider: ctx.provider, modelId: ctx.modelId })
  ) {
    // Preserve the legacy Moonshot compatibility path when no plugin wrapper
    // actually handled the stream function. This mainly covers tests and
    // disabled plugins for the native Moonshot provider.
    const thinkingType = resolveMoonshotThinkingType({
      configuredThinking: ctx.sanitizedExtraParams?.thinking,
      thinkingLevel: ctx.thinkingLevel,
    });
    ctx.agent.streamFn = createMoonshotThinkingWrapper(ctx.agent.streamFn, thinkingType);
  }

  if (ctx.provider === "amazon-bedrock" && !isAnthropicBedrockModel(ctx.modelId)) {
    log.debug(
      `disabling prompt caching for non-Anthropic Bedrock model ${ctx.provider}/${ctx.modelId}`,
    );
    ctx.agent.streamFn = createBedrockNoCacheWrapper(ctx.agent.streamFn);
  }

  // Guard Google payloads against invalid negative thinking budgets emitted by
  // upstream model-ID heuristics for Gemini 3.1 variants.
  ctx.agent.streamFn = createGoogleThinkingPayloadWrapper(ctx.agent.streamFn, ctx.thinkingLevel);

  const anthropicFastMode = resolveAnthropicFastMode(ctx.effectiveExtraParams);
  if (anthropicFastMode !== undefined) {
    log.debug(
      `applying Anthropic fast mode=${anthropicFastMode} for ${ctx.provider}/${ctx.modelId}`,
    );
    ctx.agent.streamFn = createAnthropicFastModeWrapper(ctx.agent.streamFn, anthropicFastMode);
  }

  if (typeof ctx.effectiveExtraParams?.fastMode === "boolean") {
    log.debug(
      `applying MiniMax fast mode=${ctx.effectiveExtraParams.fastMode} for ${ctx.provider}/${ctx.modelId}`,
    );
    ctx.agent.streamFn = createMinimaxFastModeWrapper(
      ctx.agent.streamFn,
      ctx.effectiveExtraParams.fastMode,
    );
  }

  const openAIFastMode = resolveOpenAIFastMode(ctx.effectiveExtraParams);
  if (openAIFastMode) {
    log.debug(`applying OpenAI fast mode for ${ctx.provider}/${ctx.modelId}`);
    ctx.agent.streamFn = createOpenAIFastModeWrapper(ctx.agent.streamFn);
  }

  const openAIServiceTier = resolveOpenAIServiceTier(ctx.sanitizedExtraParams);
  if (openAIServiceTier) {
    log.debug(
      `applying OpenAI service_tier=${openAIServiceTier} for ${ctx.provider}/${ctx.modelId}`,
    );
    ctx.agent.streamFn = createOpenAIServiceTierWrapper(ctx.agent.streamFn, openAIServiceTier);
  }

  // Work around upstream pi-ai hardcoding `store: false` for Responses API.
  // Force `store=true` for direct OpenAI Responses models and auto-enable
  // server-side compaction for compatible OpenAI Responses payloads.
  ctx.agent.streamFn = createOpenAIResponsesContextManagementWrapper(
    ctx.agent.streamFn,
    ctx.sanitizedExtraParams,
  );

  const rawParallelToolCalls = resolveAliasedParamValue(
    [ctx.resolvedExtraParams, ctx.override],
    "parallel_tool_calls",
    "parallelToolCalls",
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

/**
 * Apply extra params (like temperature) to an agent's streamFn.
 * Also applies verified provider-specific request wrappers, such as OpenRouter attribution.
 *
 * @internal Exported for testing
 */
export function applyExtraParamsToAgent(
  agent: { streamFn?: StreamFn },
  cfg: OpenClawConfig | undefined,
  provider: string,
  modelId: string,
  extraParamsOverride?: Record<string, unknown>,
  thinkingLevel?: ThinkLevel,
  agentId?: string,
  workspaceDir?: string,
  model?: ProviderRuntimeModel,
  allowedToolNames?: Set<string>,
): { effectiveExtraParams: Record<string, unknown> } {
  const resolvedExtraParams = resolveExtraParams({
    cfg,
    provider,
    modelId,
    agentId,
  });
  const override =
    extraParamsOverride && Object.keys(extraParamsOverride).length > 0
      ? Object.fromEntries(
          Object.entries(extraParamsOverride).filter(([, value]) => value !== undefined),
        )
      : undefined;
  const effectiveExtraParams = resolvePreparedExtraParams({
    cfg,
    provider,
    modelId,
    extraParamsOverride,
    thinkingLevel,
    agentId,
    resolvedExtraParams,
  });
  const sanitizedExtraParams =
    sanitizeToolChoiceOverride(effectiveExtraParams, allowedToolNames) ?? effectiveExtraParams;

  const wrapperContext: ApplyExtraParamsContext = {
    agent,
    cfg,
    provider,
    modelId,
    workspaceDir,
    thinkingLevel,
    model,
    effectiveExtraParams,
    sanitizedExtraParams,
    resolvedExtraParams,
    override,
  };

  applyPrePluginStreamWrappers(wrapperContext);
  const providerStreamBase = agent.streamFn;
  const pluginWrappedStreamFn = providerRuntimeDeps.wrapProviderStreamFn({
    provider,
    config: cfg,
    context: {
      config: cfg,
      provider,
      modelId,
      extraParams: sanitizedExtraParams,
      thinkingLevel,
      model,
      streamFn: providerStreamBase,
    },
  });
  agent.streamFn = pluginWrappedStreamFn ?? providerStreamBase;
  const providerWrapperHandled =
    pluginWrappedStreamFn !== undefined && pluginWrappedStreamFn !== providerStreamBase;
  applyPostPluginStreamWrappers({
    ...wrapperContext,
    providerWrapperHandled,
  });

  return { effectiveExtraParams };
}
