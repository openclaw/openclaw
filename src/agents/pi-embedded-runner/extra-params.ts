import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import { log } from "./logger.js";

/**
 * Minimum tokens to reserve for model output.
 * Even when context is nearly full, we need some room for a response.
 */
const MIN_OUTPUT_TOKENS = 1024;

/**
 * Safety margin to account for token estimation inaccuracy.
 * We slightly overestimate input tokens to avoid hitting exact limits.
 */
const TOKEN_ESTIMATION_SAFETY_MARGIN = 1.05;

const OPENROUTER_APP_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-Title": "OpenClaw",
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
}): Record<string, unknown> | undefined {
  const modelKey = `${params.provider}/${params.modelId}`;
  const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
  return modelConfig?.params ? { ...modelConfig.params } : undefined;
}

type CacheRetention = "none" | "short" | "long";
type CacheRetentionStreamOptions = Partial<SimpleStreamOptions> & {
  cacheRetention?: CacheRetention;
};

/**
 * Resolve cacheRetention from extraParams, supporting both new `cacheRetention`
 * and legacy `cacheControlTtl` values for backwards compatibility.
 *
 * Mapping: "5m" → "short", "1h" → "long"
 *
 * Only applies to Anthropic provider (OpenRouter uses openai-completions API
 * with hardcoded cache_control, not the cacheRetention stream option).
 */
function resolveCacheRetention(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): CacheRetention | undefined {
  if (provider !== "anthropic") {
    return undefined;
  }

  // Prefer new cacheRetention if present
  const newVal = extraParams?.cacheRetention;
  if (newVal === "none" || newVal === "short" || newVal === "long") {
    return newVal;
  }

  // Fall back to legacy cacheControlTtl with mapping
  const legacy = extraParams?.cacheControlTtl;
  if (legacy === "5m") {
    return "short";
  }
  if (legacy === "1h") {
    return "long";
  }
  return undefined;
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
  const cacheRetention = resolveCacheRetention(extraParams, provider);
  if (cacheRetention) {
    streamParams.cacheRetention = cacheRetention;
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
 * Create a streamFn wrapper that adds OpenRouter app attribution headers.
 * These headers allow OpenClaw to appear on OpenRouter's leaderboard.
 */
function createOpenRouterHeadersWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      headers: {
        ...OPENROUTER_APP_HEADERS,
        ...options?.headers,
      },
    });
}

/**
 * Estimate total input tokens from the context (system prompt + messages).
 * Applies a safety margin to account for token estimation inaccuracy.
 *
 * @internal Exported for testing
 */
export function estimateInputTokens(context: {
  system?: string;
  messages?: unknown[];
}): number {
  let totalTokens = 0;

  // Estimate system prompt tokens
  if (context.system) {
    totalTokens += estimateTokens({ role: "system", content: context.system });
  }

  // Estimate message tokens
  if (Array.isArray(context.messages)) {
    for (const message of context.messages) {
      if (message && typeof message === "object") {
        totalTokens += estimateTokens(message);
      }
    }
  }

  // Apply safety margin for estimation inaccuracy
  return Math.ceil(totalTokens * TOKEN_ESTIMATION_SAFETY_MARGIN);
}

/**
 * Calculate the maximum allowed output tokens based on remaining context space.
 * Returns the capped maxTokens value, ensuring it doesn't exceed the remaining
 * context window after accounting for input tokens.
 *
 * Fixes issue #7587: LLM request rejected when input length and max_tokens exceed context limit
 *
 * @internal Exported for testing
 */
export function calculateCappedMaxTokens(params: {
  requestedMaxTokens: number | undefined;
  modelMaxTokens: number | undefined;
  contextWindow: number;
  inputTokens: number;
}): number {
  const { requestedMaxTokens, modelMaxTokens, contextWindow, inputTokens } = params;

  // Calculate remaining context space for output
  const remainingTokens = contextWindow - inputTokens;

  // Ensure we have at least minimum output tokens
  if (remainingTokens < MIN_OUTPUT_TOKENS) {
    log.warn(
      `Context nearly full: input=${inputTokens} contextWindow=${contextWindow} ` +
        `remaining=${remainingTokens} (min=${MIN_OUTPUT_TOKENS})`,
    );
    return MIN_OUTPUT_TOKENS;
  }

  // Determine the effective maxTokens to use
  const effectiveMax = requestedMaxTokens ?? modelMaxTokens ?? remainingTokens;

  // Cap to remaining context space
  if (effectiveMax > remainingTokens) {
    log.debug(
      `Capping maxTokens: requested=${effectiveMax} capped=${remainingTokens} ` +
        `(input=${inputTokens} contextWindow=${contextWindow})`,
    );
    return remainingTokens;
  }

  return effectiveMax;
}

/**
 * Create a streamFn wrapper that dynamically caps maxTokens based on remaining context.
 * This prevents "input length and max_tokens exceed context limit" errors by ensuring
 * the total (input + maxTokens) never exceeds the model's context window.
 *
 * Fixes issue #7587: LLM request rejected when input length and max_tokens exceed context limit
 */
function createMaxTokensCapWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;

  return (model, context, options) => {
    const contextWindow = model?.contextWindow;

    // If no context window defined, pass through without modification
    if (!contextWindow || contextWindow <= 0) {
      return underlying(model, context, options);
    }

    // Estimate input tokens from the context
    const inputTokens = estimateInputTokens(context);

    // Calculate capped maxTokens
    const cappedMaxTokens = calculateCappedMaxTokens({
      requestedMaxTokens: options?.maxTokens,
      modelMaxTokens: model?.maxTokens,
      contextWindow,
      inputTokens,
    });

    // Only modify options if capping is needed
    const currentMax = options?.maxTokens ?? model?.maxTokens;
    if (currentMax && cappedMaxTokens < currentMax) {
      return underlying(model, context, {
        ...options,
        maxTokens: cappedMaxTokens,
      });
    }

    return underlying(model, context, options);
  };
}

/**
 * Apply extra params (like temperature) to an agent's streamFn.
 * Also adds OpenRouter app attribution headers when using the OpenRouter provider.
 * Additionally applies maxTokens capping to prevent context overflow errors.
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
  const wrappedStreamFn = createStreamFnWithExtraParams(agent.streamFn, merged, provider);

  if (wrappedStreamFn) {
    log.debug(`applying extraParams to agent streamFn for ${provider}/${modelId}`);
    agent.streamFn = wrappedStreamFn;
  }

  if (provider === "openrouter") {
    log.debug(`applying OpenRouter app attribution headers for ${provider}/${modelId}`);
    agent.streamFn = createOpenRouterHeadersWrapper(agent.streamFn);
  }

  // Apply maxTokens capping to prevent context overflow errors (fixes #7587)
  // This wrapper must be applied last so it can see the final options before the API call
  agent.streamFn = createMaxTokensCapWrapper(agent.streamFn);
}
