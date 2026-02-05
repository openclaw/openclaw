import type { StreamFn } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { SAFETY_MARGIN } from "../compaction.js";
import { log } from "./logger.js";

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

const CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
  "zai/glm-4.7": 200000,
};

const MODEL_MAX_TOKENS_OVERRIDES: Record<string, number> = {
  "zai/glm-4.7": 128000,
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

function resolveModelContextWindow(
  model: { contextWindow?: number } | undefined,
  provider: string,
  modelId: string,
): number | undefined {
  if (model?.contextWindow && model.contextWindow > 0) {
    return model.contextWindow;
  }
  const key = `${provider}/${modelId}`;
  return CONTEXT_WINDOW_OVERRIDES[key];
}

function resolveModelMaxTokens(
  model: { maxTokens?: number } | undefined,
  provider: string,
  modelId: string,
): number | undefined {
  if (model?.maxTokens && model.maxTokens > 0) {
    return model.maxTokens;
  }
  const key = `${provider}/${modelId}`;
  return MODEL_MAX_TOKENS_OVERRIDES[key];
}

export function estimateInputTokens(params: {
  system?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
}): number {
  let total = 0;
  if (params.system && params.system.trim()) {
    total += estimateTokens({ role: "system", content: params.system });
  }
  for (const message of params.messages ?? []) {
    total += estimateTokens(message as Parameters<typeof estimateTokens>[0]);
  }
  return Math.ceil(total * SAFETY_MARGIN);
}

export function calculateCappedMaxTokens(params: {
  requestedMaxTokens?: number;
  modelMaxTokens?: number;
  contextWindow?: number;
  inputTokens: number;
}): number | undefined {
  const contextWindow =
    typeof params.contextWindow === "number" && params.contextWindow > 0
      ? params.contextWindow
      : undefined;
  if (!contextWindow) {
    return undefined;
  }

  const remaining = Math.max(contextWindow - params.inputTokens, 0);
  if (remaining <= 0) {
    return 0;
  }

  let target =
    typeof params.requestedMaxTokens === "number" && params.requestedMaxTokens > 0
      ? params.requestedMaxTokens
      : typeof params.modelMaxTokens === "number" && params.modelMaxTokens > 0
        ? params.modelMaxTokens
        : remaining;

  if (typeof params.modelMaxTokens === "number" && params.modelMaxTokens > 0) {
    target = Math.min(target, params.modelMaxTokens);
  }

  const capped = Math.min(target, remaining);
  if (capped <= 0) {
    return 0;
  }
  return capped;
}

function createMaxTokensCapWrapper(
  baseStreamFn: StreamFn | undefined,
  provider: string,
  modelId: string,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const contextWindow = resolveModelContextWindow(model, provider, modelId);
    const modelMaxTokens = resolveModelMaxTokens(model, provider, modelId);
    if (!contextWindow) {
      return underlying(model, context, options);
    }

    const inputTokens = estimateInputTokens({
      system: (context as { system?: string })?.system,
      messages: (context as { messages?: Array<{ role?: string; content?: unknown }> })?.messages,
    });
    const cappedMaxTokens = calculateCappedMaxTokens({
      requestedMaxTokens: options?.maxTokens,
      modelMaxTokens,
      contextWindow,
      inputTokens,
    });
    if (cappedMaxTokens === undefined) {
      return underlying(model, context, options);
    }

    if (typeof options?.maxTokens === "number" && cappedMaxTokens < options.maxTokens) {
      log.debug(
        `capping maxTokens for ${provider}/${modelId} from ${options.maxTokens} to ${cappedMaxTokens}`,
      );
    }

    const nextOptions =
      cappedMaxTokens !== undefined ? { ...options, maxTokens: cappedMaxTokens } : options;
    return underlying(model, context, nextOptions);
  };
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

  agent.streamFn = createMaxTokensCapWrapper(agent.streamFn, provider, modelId);

  if (provider === "openrouter") {
    log.debug(`applying OpenRouter app attribution headers for ${provider}/${modelId}`);
    agent.streamFn = createOpenRouterHeadersWrapper(agent.streamFn);
  }
}
