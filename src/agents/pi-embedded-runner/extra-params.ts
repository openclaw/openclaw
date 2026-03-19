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
  createOpenAIFastModeWrapper,
  createOpenAIResponsesContextManagementWrapper,
  createOpenAIServiceTierWrapper,
  resolveOpenAIFastMode,
  resolveOpenAIServiceTier,
} from "./openai-stream-wrappers.js";

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
 * Create a stream wrapper that converts API-key auth to Bearer token auth and
 * strips Anthropic-specific beta headers unsupported by third-party endpoints.
 *
 * Some Anthropic-compatible endpoints (e.g. MiniMax) require
 * `Authorization: Bearer <key>` instead of Anthropic SDK's default `X-Api-Key`,
 * and do not support Anthropic-specific beta features injected by pi-ai
 * (e.g. `fine-grained-tool-streaming-2025-05-14`, `interleaved-thinking-2025-05-14`).
 * When these unsupported beta headers are received, MiniMax sends the entire
 * response as a single SSE chunk rather than incremental token deltas, causing
 * the TUI to display the response all at once instead of streaming.
 *
 * This wrapper intercepts every stream call and:
 *   1. Moves `options.apiKey` to `options.headers["Authorization"]` as Bearer.
 *   2. Nulls out `X-Api-Key` so the Anthropic SDK does not emit that header.
 *      (The SDK treats a null header value as an explicit deletion.)
 *   3. Clears `options.apiKey` so pi-ai passes `apiKey=null` to the client,
 *      preventing the `X-Api-Key` header from being generated.
 *   4. Nulls out `anthropic-beta` to suppress pi-ai's default beta headers that
 *      MiniMax does not recognise and which degrade its streaming behaviour.
 */
function createBearerAuthWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
    if (!apiKey) {
      return underlying(model, context, options);
    }
    return underlying(model, context, {
      ...options,
      // Clear apiKey so the Anthropic client receives apiKey=null and skips X-Api-Key.
      apiKey: undefined,
      headers: {
        ...options?.headers,
        // Explicitly delete x-api-key (null means "remove" in the Anthropic SDK header merge).
        "X-Api-Key": null as unknown as string,
        Authorization: `Bearer ${apiKey}`,
        // Suppress pi-ai's default anthropic-beta headers (fine-grained-tool-streaming,
        // interleaved-thinking) that MiniMax's Anthropic-compat endpoint does not support.
        // When these are present, MiniMax returns the entire response as a single SSE
        // chunk instead of token-by-token deltas, breaking streaming in TUI.
        "anthropic-beta": null as unknown as string,
      },
    });
  };
}

/**
 * Determine if a provider uses Bearer auth (authHeader: true) for its
 * anthropic-messages endpoint. Reads the provider config from models.json.
 */
function resolveProviderAuthHeader(cfg: OpenClawConfig | undefined, provider: string): boolean {
  const providers = cfg?.models?.providers ?? {};
  return providers[provider]?.authHeader === true;
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

  // When authHeader: true, the provider's Anthropic-compatible endpoint expects
  // Authorization: Bearer rather than x-api-key. Wrap the streamFn to convert auth.
  if (resolveProviderAuthHeader(cfg, provider)) {
    log.debug(`applying Bearer auth header wrapper for ${provider}/${modelId}`);
    agent.streamFn = createBearerAuthWrapper(agent.streamFn);
  }

  if (shouldApplySiliconFlowThinkingOffCompat({ provider, modelId, thinkingLevel })) {
    log.debug(
      `normalizing thinking=off to thinking=null for SiliconFlow compatibility (${provider}/${modelId})`,
    );
    agent.streamFn = createSiliconFlowThinkingWrapper(agent.streamFn);
  }

  agent.streamFn = createAnthropicToolPayloadCompatibilityWrapper(agent.streamFn, {
    config: cfg,
    workspaceDir,
  });
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
