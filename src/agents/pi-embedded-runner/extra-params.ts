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

function createStreamFnWithExtraParams(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
  provider: string,
  modelId: string,
): StreamFn | undefined {
  if (!extraParams || Object.keys(extraParams).length === 0) {
    return undefined;
  }

  const streamParams: Partial<SimpleStreamOptions> & { cacheControlTtl?: CacheControlTtl } = {};
  if (typeof extraParams.temperature === "number") {
    streamParams.temperature = extraParams.temperature;
  }
  if (typeof extraParams.maxTokens === "number") {
    streamParams.maxTokens = extraParams.maxTokens;
  }
  const cacheControlTtl = resolveCacheControlTtl(extraParams, provider, modelId);
  if (cacheControlTtl) {
    streamParams.cacheControlTtl = cacheControlTtl;
  }

  if (Object.keys(streamParams).length === 0) {
    return undefined;
  }

  log.debug(`creating streamFn wrapper with params: ${JSON.stringify(streamParams)}`);

  const underlying = baseStreamFn ?? streamSimple;
  const wrappedStreamFn: StreamFn = (model, context, options) =>
    underlying(model, context, {
      ...streamParams,
      ...options,
    });

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

  // Apply role transformation for incompatible providers
  if (needsRoleTransformation(provider, modelId)) {
    log.debug(`applying developer->system role transformation for ${provider}/${modelId}`);
    const originalStreamFn = agent.streamFn ?? streamSimple;
    agent.streamFn = (model, context, options) => {
      const transformedContext = {
        ...context,
        messages: transformDeveloperRole(context.messages),
      };
      return originalStreamFn(model, transformedContext, options);
    };
  }
}

/**
 * Check if a provider requires developer -> system role transformation.
 * Only returns true for known incompatible providers (DeepSeek).
 * Default is false (no transformation) to avoid breaking other providers.
 *
 * @internal Exported for testing
 */
export function needsRoleTransformation(provider: string, modelId: string): boolean {
  // Only DeepSeek models are known to not support "developer" role
  if (modelId.toLowerCase().includes("deepseek")) {
    return true;
  }
  // Default: no transformation for unknown providers
  // This avoids breaking providers that may handle "developer" differently
  return false;
}

/**
 * Transform developer role messages to system role for incompatible providers.
 *
 * @internal Exported for testing
 */
export function transformDeveloperRole(
  messages: Array<{ role: string; content: unknown }>,
): Array<{ role: string; content: unknown }> {
  return messages.map((msg) =>
    msg.role === "developer" ? { ...msg, role: "system" } : msg,
  );
}
