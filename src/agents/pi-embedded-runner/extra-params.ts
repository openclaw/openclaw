import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { log } from "./logger.js";

const OPENROUTER_APP_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-Title": "OpenClaw",
};

/** Default server-side compaction strategy for Anthropic API. */
const DEFAULT_COMPACTION_STRATEGY = "compact_20260112";

/** Beta header required for Anthropic server-side compaction. */
const ANTHROPIC_CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";

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
 * Resolve server-side compaction configuration for Anthropic provider.
 * Returns undefined if not enabled or not applicable.
 */
function resolveServerSideCompaction(
  cfg: OpenClawConfig | undefined,
  provider: string,
): { strategy: string } | undefined {
  if (provider !== "anthropic") {
    return undefined;
  }

  const serverSideConfig = cfg?.agents?.defaults?.compaction?.serverSide;
  if (!serverSideConfig?.enabled) {
    return undefined;
  }

  return {
    strategy: serverSideConfig.strategy ?? DEFAULT_COMPACTION_STRATEGY,
  };
}

/**
 * Create a streamFn wrapper that adds Anthropic server-side compaction parameters.
 * Adds the context-management beta header and context_management.edits body parameter.
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/compaction
 */
function createAnthropicServerSideCompactionWrapper(
  baseStreamFn: StreamFn | undefined,
  strategy: string,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;

  log.debug(`enabling Anthropic server-side compaction with strategy: ${strategy}`);

  return (model, context, options) => {
    // Add beta header for context management.
    // Cast to Record<string, unknown> since runtime headers may contain non-string values.
    const existingHeaders = (options?.headers ?? {}) as Record<string, unknown>;
    const existingBeta = existingHeaders["anthropic-beta"];
    const betaValue =
      typeof existingBeta === "string" && existingBeta.length > 0
        ? `${existingBeta},${ANTHROPIC_CONTEXT_MANAGEMENT_BETA}`
        : ANTHROPIC_CONTEXT_MANAGEMENT_BETA;

    // Merge with any existing extraBody, preserving existing context_management fields
    const existingExtraBody =
      options && "extraBody" in options
        ? (options as { extraBody?: unknown }).extraBody
        : undefined;
    const existingExtraBodyObj =
      typeof existingExtraBody === "object" && existingExtraBody !== null
        ? (existingExtraBody as Record<string, unknown>)
        : {};
    const existingCtxMgmt = existingExtraBodyObj.context_management as
      | { edits?: unknown[] }
      | undefined;
    const existingEdits =
      existingCtxMgmt !== null &&
      existingCtxMgmt !== undefined &&
      Array.isArray(existingCtxMgmt.edits)
        ? existingCtxMgmt.edits
        : [];

    const extraBody = {
      ...existingExtraBodyObj,
      context_management: {
        ...existingCtxMgmt,
        edits: [...existingEdits, { type: strategy }],
      },
    };

    return underlying(model, context, {
      ...options,
      headers: {
        ...existingHeaders,
        "anthropic-beta": betaValue,
      },
      extraBody,
    } as SimpleStreamOptions);
  };
}

/**
 * Apply extra params (like temperature) to an agent's streamFn.
 * Also adds OpenRouter app attribution headers when using the OpenRouter provider,
 * and Anthropic server-side compaction when configured.
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

  // Apply Anthropic server-side compaction if enabled
  const serverSideCompaction = resolveServerSideCompaction(cfg, provider);
  if (serverSideCompaction) {
    log.info(
      `enabling Anthropic server-side compaction for ${provider}/${modelId} with strategy: ${serverSideCompaction.strategy}`,
    );
    agent.streamFn = createAnthropicServerSideCompactionWrapper(
      agent.streamFn,
      serverSideCompaction.strategy,
    );
  }
}
