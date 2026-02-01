import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { log } from "./logger.js";

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
}): Record<string, unknown> | undefined {
  const modelKey = `${params.provider}/${params.modelId}`;
  const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
  return modelConfig?.params ? { ...modelConfig.params } : undefined;
}

type CacheControlTtl = "5m" | "1h";

function resolveCacheControlTtl(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
  modelId: string,
): CacheControlTtl | undefined {
  const raw = extraParams?.cacheControlTtl;
  if (raw !== "5m" && raw !== "1h") {
    return undefined;
  }
  if (provider === "anthropic") {
    return raw;
  }
  if (provider === "openrouter" && modelId.startsWith("anthropic/")) {
    return raw;
  }
  return undefined;
}

/**
 * Check if a provider requires developer -> system role transformation.
 * DeepSeek and other non-OpenAI providers don't support the "developer" role.
 *
 * @internal Exported for testing
 */
export function needsRoleTransformation(provider: string, modelId: string): boolean {
  // DeepSeek models don't support "developer" role
  if (modelId.toLowerCase().includes("deepseek")) {
    return true;
  }
  // OpenAI supports "developer" role natively
  if (provider === "openai") {
    return false;
  }
  // OpenRouter with OpenAI models (except o1 series which use "developer")
  if (provider === "openrouter" && modelId.startsWith("openai/")) {
    return false;
  }
  // Default: assume non-OpenAI providers need transformation
  return true;
}

/**
 * Transform "developer" role messages to "system" role for providers that don't support it.
 *
 * @internal Exported for testing
 */
export function transformDeveloperRole(
  context: { messages?: Array<{ role: string; content: unknown }> },
): { messages?: Array<{ role: string; content: unknown }> } {
  if (!context.messages || context.messages.length === 0) {
    return context;
  }

  const transformed = context.messages.map((msg) => {
    if (msg.role === "developer") {
      return { ...msg, role: "system" };
    }
    return msg;
  });

  return { ...context, messages: transformed };
}

function createStreamFnWithExtraParams(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
  provider: string,
  modelId: string,
): StreamFn | undefined {
  const hasExtraParams = extraParams && Object.keys(extraParams).length > 0;
  const needsRoleTransform = needsRoleTransformation(provider, modelId);

  if (!hasExtraParams && !needsRoleTransform) {
    return undefined;
  }

  const streamParams: Partial<SimpleStreamOptions> & { cacheControlTtl?: CacheControlTtl } = {};
  if (typeof extraParams?.temperature === "number") {
    streamParams.temperature = extraParams.temperature;
  }
  if (typeof extraParams?.maxTokens === "number") {
    streamParams.maxTokens = extraParams.maxTokens;
  }
  const cacheControlTtl = resolveCacheControlTtl(extraParams, provider, modelId);
  if (cacheControlTtl) {
    streamParams.cacheControlTtl = cacheControlTtl;
  }

  const hasStreamParams = Object.keys(streamParams).length > 0;

  if (!hasStreamParams && !needsRoleTransform) {
    return undefined;
  }

  log.debug(`creating streamFn wrapper with params: ${JSON.stringify(streamParams)}, roleTransform: ${needsRoleTransform}`);

  const underlying = baseStreamFn ?? streamSimple;
  const wrappedStreamFn: StreamFn = (model, context, options) => {
    // Transform context messages if needed (developer -> system)
    const transformedContext = needsRoleTransform
      ? transformDeveloperRole(context as { messages?: Array<{ role: string; content: unknown }> })
      : context;

    return underlying(model, transformedContext, {
      ...streamParams,
      ...options,
    });
  };

  return wrappedStreamFn;
}

/**
 * Apply extra params (like temperature) to an agent's streamFn.
 *
 * @internal Exported for testing
 */
export function applyExtraParamsToAgent(
  agent: { streamFn?: StreamFn },
  cfg: OpenClawConfig | undefined,
  provider: string,
  modelId: string,
  extraParamsOverride?: Record<string, unknown>,
): void {
  const extraParams = resolveExtraParams({
    cfg,
    provider,
    modelId,
  });
  const override =
    extraParamsOverride && Object.keys(extraParamsOverride).length > 0
      ? Object.fromEntries(
          Object.entries(extraParamsOverride).filter(([, value]) => value !== undefined),
        )
      : undefined;
  const merged = Object.assign({}, extraParams, override);
  const wrappedStreamFn = createStreamFnWithExtraParams(agent.streamFn, merged, provider, modelId);

  if (wrappedStreamFn) {
    log.debug(`applying extraParams to agent streamFn for ${provider}/${modelId}`);
    agent.streamFn = wrappedStreamFn;
  }
}
