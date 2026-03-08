import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  prepareProviderExtraParams,
  wrapProviderStreamFn,
} from "../../plugins/provider-runtime.js";
import {
  createAnthropicBetaHeadersWrapper,
  createAnthropicFastModeWrapper,
  createAnthropicToolPayloadCompatibilityWrapper,
  createBedrockNoCacheWrapper,
  isAnthropicBedrockModel,
  resolveAnthropicFastMode,
  resolveAnthropicBetas,
  resolveCacheRetention,
} from "./anthropic-stream-wrappers.js";
import { log } from "./logger.js";
import {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
  createSiliconFlowThinkingWrapper,
  shouldApplyMoonshotPayloadCompat,
  shouldApplySiliconFlowThinkingOffCompat,
} from "./moonshot-stream-wrappers.js";
import {
  createOpenAIDefaultTransportWrapper,
  createOpenAIFastModeWrapper,
  createOpenAIResponsesContextManagementWrapper,
  createOpenAIServiceTierWrapper,
  resolveOpenAIFastMode,
  resolveOpenAIServiceTier,
} from "./openai-stream-wrappers.js";
import { createZaiToolStreamWrapper } from "./zai-stream-wrappers.js";

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
  azureApiVersion?: string;
};

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
  const transport = extraParams.transport;
  if (transport === "sse" || transport === "websocket" || transport === "auto") {
    streamParams.transport = transport;
  } else if (transport != null) {
    const transportSummary = typeof transport === "string" ? transport : typeof transport;
    log.warn(`ignoring invalid transport param: ${transportSummary}`);
  }
  if (typeof extraParams.openaiWsWarmup === "boolean") {
    streamParams.openaiWsWarmup = extraParams.openaiWsWarmup;
  }
  if (provider === "azure-openai-responses" && typeof extraParams.azureApiVersion === "string") {
    const normalized = extraParams.azureApiVersion.trim();
    if (normalized) {
      streamParams.azureApiVersion = normalized;
    }
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

function isGemini31Model(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return normalized.includes("gemini-3.1-pro") || normalized.includes("gemini-3.1-flash");
}

function mapThinkLevelToGoogleThinkingLevel(
  thinkingLevel: ThinkLevel,
): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | undefined {
  switch (thinkingLevel) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
    case "adaptive":
      return "MEDIUM";
    case "high":
    case "xhigh":
      return "HIGH";
    default:
      return undefined;
  }
}

function sanitizeGoogleThinkingPayload(params: {
  payload: unknown;
  modelId?: string;
  thinkingLevel?: ThinkLevel;
}): void {
  if (!params.payload || typeof params.payload !== "object") {
    return;
  }
  const payloadObj = params.payload as Record<string, unknown>;
  const config = payloadObj.config;
  if (!config || typeof config !== "object") {
    return;
  }
  const configObj = config as Record<string, unknown>;
  const thinkingConfig = configObj.thinkingConfig;
  if (!thinkingConfig || typeof thinkingConfig !== "object") {
    return;
  }
  const thinkingConfigObj = thinkingConfig as Record<string, unknown>;
  const thinkingBudget = thinkingConfigObj.thinkingBudget;
  if (typeof thinkingBudget !== "number" || thinkingBudget >= 0) {
    return;
  }

  // pi-ai can emit thinkingBudget=-1 for some Gemini 3.1 IDs; a negative budget
  // is invalid for Google-compatible backends and can lead to malformed handling.
  delete thinkingConfigObj.thinkingBudget;

  if (
    typeof params.modelId === "string" &&
    isGemini31Model(params.modelId) &&
    params.thinkingLevel &&
    params.thinkingLevel !== "off" &&
    thinkingConfigObj.thinkingLevel === undefined
  ) {
    const mappedLevel = mapThinkLevelToGoogleThinkingLevel(params.thinkingLevel);
    if (mappedLevel) {
      thinkingConfigObj.thinkingLevel = mappedLevel;
    }
  }
}

function createGoogleThinkingPayloadWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const onPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (model.api === "google-generative-ai") {
          sanitizeGoogleThinkingPayload({
            payload,
            modelId: model.id,
            thinkingLevel,
          });
        }
        return onPayload?.(payload, model);
      },
    });
  };
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
 * Also adds OpenRouter app attribution headers when using the OpenRouter provider.
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
): void {
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
  const merged = Object.assign({}, resolvedExtraParams, override);
  const effectiveExtraParams =
    prepareProviderExtraParams({
      provider,
      config: cfg,
      context: {
        config: cfg,
        provider,
        modelId,
        extraParams: merged,
        thinkingLevel,
      },
    }) ?? merged;

  if (provider === "openai") {
    // Default OpenAI Responses to WebSocket-first with transparent SSE fallback.
    agent.streamFn = createOpenAIDefaultTransportWrapper(agent.streamFn);
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

  agent.streamFn = createAnthropicToolPayloadCompatibilityWrapper(agent.streamFn);
  const providerStreamBase = agent.streamFn;
  const pluginWrappedStreamFn = wrapProviderStreamFn({
    provider,
    config: cfg,
    context: {
      config: cfg,
      provider,
      modelId,
      extraParams: effectiveExtraParams,
      thinkingLevel,
      streamFn: providerStreamBase,
    },
  });
  agent.streamFn = pluginWrappedStreamFn ?? providerStreamBase;
  const providerWrapperHandled =
    pluginWrappedStreamFn !== undefined && pluginWrappedStreamFn !== providerStreamBase;

  if (!providerWrapperHandled && shouldApplyMoonshotPayloadCompat({ provider, modelId })) {
    // Preserve the legacy Moonshot compatibility path when no plugin wrapper
    // actually handled the stream function. This covers tests/disabled plugins
    // and Ollama Cloud Kimi models until they gain a dedicated runtime hook.
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

  // Enable Z.AI tool_stream for real-time tool call streaming.
  // Enabled by default for Z.AI provider, can be disabled via params.tool_stream: false
  if (provider === "zai" || provider === "z-ai") {
    const toolStreamEnabled = effectiveExtraParams?.tool_stream !== false;
    if (toolStreamEnabled) {
      log.debug(`enabling Z.AI tool_stream for ${provider}/${modelId}`);
      agent.streamFn = createZaiToolStreamWrapper(agent.streamFn, true);
    }
  }

  // Guard Google payloads against invalid negative thinking budgets emitted by
  // upstream model-ID heuristics for Gemini 3.1 variants.
  agent.streamFn = createGoogleThinkingPayloadWrapper(agent.streamFn, thinkingLevel);

  const anthropicFastMode = resolveAnthropicFastMode(effectiveExtraParams);
  if (anthropicFastMode !== undefined) {
    log.debug(`applying Anthropic fast mode=${anthropicFastMode} for ${provider}/${modelId}`);
    agent.streamFn = createAnthropicFastModeWrapper(agent.streamFn, anthropicFastMode);
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
}
