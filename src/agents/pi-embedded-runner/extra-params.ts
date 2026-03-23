import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  prepareProviderExtraParams as prepareProviderExtraParamsRuntime,
  wrapProviderStreamFn as wrapProviderStreamFnRuntime,
} from "../../plugins/provider-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/types.js";
import {
  createAnthropicBetaHeadersWrapper,
  createBedrockNoCacheWrapper,
  createAnthropicFastModeWrapper,
  createAnthropicToolPayloadCompatibilityWrapper,
  isAnthropicBedrockModel,
  resolveAnthropicFastMode,
  resolveAnthropicBetas,
  resolveCacheRetention,
} from "./anthropic-stream-wrappers.js";
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
import { createXaiFastModeWrapper } from "./xai-stream-wrappers.js";

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
};
type SupportedTransport = Exclude<CacheRetentionStreamOptions["transport"], undefined>;

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
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          (payload as Record<string, unknown>).parallel_tool_calls = enabled;
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
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

  if (provider === "openai" || provider === "openai-codex") {
    if (provider === "openai") {
      // Default OpenAI Responses to WebSocket-first with transparent SSE fallback.
      agent.streamFn = createOpenAIDefaultTransportWrapper(agent.streamFn);
    }
    agent.streamFn = createOpenAIAttributionHeadersWrapper(agent.streamFn);
  }

  const wrappedStreamFn = createStreamFnWithExtraParams(
    agent.streamFn,
    effectiveExtraParams,
    provider,
  );

  if (wrappedStreamFn) {
    log.debug(`applying extraParams to agent streamFn for ${provider}/${modelId}`);
    agent.streamFn = wrappedStreamFn;
  }

  const anthropicBetas = resolveAnthropicBetas(effectiveExtraParams, provider, modelId);
  if (anthropicBetas?.length) {
    log.debug(
      `applying Anthropic beta header for ${provider}/${modelId}: ${anthropicBetas.join(",")}`,
    );
    agent.streamFn = createAnthropicBetaHeadersWrapper(agent.streamFn, anthropicBetas);
  }

  if (shouldApplySiliconFlowThinkingOffCompat({ provider, modelId, thinkingLevel })) {
    log.debug(
      `normalizing thinking=off to thinking=null for SiliconFlow compatibility (${provider}/${modelId})`,
    );
    agent.streamFn = createSiliconFlowThinkingWrapper(agent.streamFn);
  }

  if (thinkingLevel === "off") {
    agent.streamFn = createOllamaThinkingOffWrapper(agent.streamFn);
  }

  agent.streamFn = createAnthropicToolPayloadCompatibilityWrapper(agent.streamFn, {
    config: cfg,
    workspaceDir,
  });
  const providerStreamBase = agent.streamFn;
  const pluginWrappedStreamFn = providerRuntimeDeps.wrapProviderStreamFn({
    provider,
    config: cfg,
    context: {
      config: cfg,
      provider,
      modelId,
      extraParams: effectiveExtraParams,
      thinkingLevel,
      model,
      streamFn: providerStreamBase,
    },
  });
  agent.streamFn = pluginWrappedStreamFn ?? providerStreamBase;
  const providerWrapperHandled =
    pluginWrappedStreamFn !== undefined && pluginWrappedStreamFn !== providerStreamBase;

  if (!providerWrapperHandled && shouldApplyMoonshotPayloadCompat({ provider, modelId })) {
    // Preserve the legacy Moonshot compatibility path when no plugin wrapper
    // actually handled the stream function. This mainly covers tests and
    // disabled plugins for the native Moonshot provider.
    const thinkingType = resolveMoonshotThinkingType({
      configuredThinking: effectiveExtraParams?.thinking,
      thinkingLevel,
    });
    agent.streamFn = createMoonshotThinkingWrapper(agent.streamFn, thinkingType);
  }

  if (provider === "amazon-bedrock" && !isAnthropicBedrockModel(modelId)) {
    log.debug(`disabling prompt caching for non-Anthropic Bedrock model ${provider}/${modelId}`);
    agent.streamFn = createBedrockNoCacheWrapper(agent.streamFn);
  }

  // Guard Google payloads against invalid negative thinking budgets emitted by
  // upstream model-ID heuristics for Gemini 3.1 variants.
  agent.streamFn = createGoogleThinkingPayloadWrapper(agent.streamFn, thinkingLevel);

  const anthropicFastMode = resolveAnthropicFastMode(effectiveExtraParams);
  if (anthropicFastMode !== undefined) {
    log.debug(`applying Anthropic fast mode=${anthropicFastMode} for ${provider}/${modelId}`);
    agent.streamFn = createAnthropicFastModeWrapper(agent.streamFn, anthropicFastMode);
  }

  if (typeof effectiveExtraParams?.fastMode === "boolean") {
    log.debug(
      `applying MiniMax fast mode=${effectiveExtraParams.fastMode} for ${provider}/${modelId}`,
    );
    agent.streamFn = createMinimaxFastModeWrapper(agent.streamFn, effectiveExtraParams.fastMode);
    log.debug(`applying xAI fast mode=${effectiveExtraParams.fastMode} for ${provider}/${modelId}`);
    agent.streamFn = createXaiFastModeWrapper(agent.streamFn, effectiveExtraParams.fastMode);
  }

  const openAIFastMode = resolveOpenAIFastMode(effectiveExtraParams);
  if (openAIFastMode) {
    log.debug(`applying OpenAI fast mode for ${provider}/${modelId}`);
    agent.streamFn = createOpenAIFastModeWrapper(agent.streamFn);
  }

  const openAIServiceTier = resolveOpenAIServiceTier(effectiveExtraParams);
  if (openAIServiceTier) {
    log.debug(`applying OpenAI service_tier=${openAIServiceTier} for ${provider}/${modelId}`);
    agent.streamFn = createOpenAIServiceTierWrapper(agent.streamFn, openAIServiceTier);
  }

  // Work around upstream pi-ai hardcoding `store: false` for Responses API.
  // Force `store=true` for direct OpenAI Responses models and auto-enable
  // server-side compaction for compatible OpenAI Responses payloads.
  agent.streamFn = createOpenAIResponsesContextManagementWrapper(
    agent.streamFn,
    effectiveExtraParams,
  );

  const rawParallelToolCalls = resolveAliasedParamValue(
    [resolvedExtraParams, override],
    "parallel_tool_calls",
    "parallelToolCalls",
  );
  if (rawParallelToolCalls !== undefined) {
    if (typeof rawParallelToolCalls === "boolean") {
      agent.streamFn = createParallelToolCallsWrapper(agent.streamFn, rawParallelToolCalls);
    } else if (rawParallelToolCalls === null) {
      log.debug("parallel_tool_calls suppressed by null override, skipping injection");
    } else {
      const summary =
        typeof rawParallelToolCalls === "string"
          ? rawParallelToolCalls
          : typeof rawParallelToolCalls;
      log.warn(`ignoring invalid parallel_tool_calls param: ${summary}`);
    }
  }

  return { effectiveExtraParams };
}

function createOllamaThinkingOffWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.api !== "ollama") {
      return underlying(model, context, options);
    }
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload, payloadModel) => {
        if (payload && typeof payload === "object") {
          (payload as Record<string, unknown>).think = false;
        }
        return originalOnPayload?.(payload, payloadModel);
      },
    });
  };
}
