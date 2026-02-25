import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import { log } from "./logger.js";

const OPENROUTER_APP_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-Title": "OpenClaw",
};
const ANTHROPIC_CONTEXT_1M_BETA = "context-1m-2025-08-07";
const ANTHROPIC_1M_MODEL_PREFIXES = ["claude-opus-4", "claude-sonnet-4"] as const;
// NOTE: We only force `store=true` for *direct* OpenAI Responses.
// Codex responses (chatgpt.com/backend-api/codex/responses) require `store=false`.
const OPENAI_RESPONSES_APIS = new Set(["openai-responses"]);
const OPENAI_RESPONSES_PROVIDERS = new Set(["openai"]);

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

  return Object.assign({}, globalParams, agentParams);
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
 * Applies to:
 * - direct Anthropic provider
 * - Anthropic Claude models on Bedrock when cache retention is explicitly configured
 *
 * OpenRouter uses openai-completions API with hardcoded cache_control instead
 * of the cacheRetention stream option.
 *
 * Defaults to "short" for direct Anthropic when not explicitly configured.
 */
function resolveCacheRetention(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): CacheRetention | undefined {
  const isAnthropicDirect = provider === "anthropic";
  const hasBedrockOverride =
    extraParams?.cacheRetention !== undefined || extraParams?.cacheControlTtl !== undefined;
  const isAnthropicBedrock = provider === "amazon-bedrock" && hasBedrockOverride;

  if (!isAnthropicDirect && !isAnthropicBedrock) {
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

  // Default to "short" only for direct Anthropic when not explicitly configured.
  // Bedrock retains upstream provider defaults unless explicitly set.
  if (!isAnthropicDirect) {
    return undefined;
  }

  // Default to "short" for direct Anthropic when not explicitly configured
  return "short";
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

  // Extract OpenRouter provider routing preferences from extraParams.provider.
  // Injected into model.compat.openRouterRouting so pi-ai's buildParams sets
  // params.provider in the API request body (openai-completions.js L359-362).
  // pi-ai's OpenRouterRouting type only declares { only?, order? }, but at
  // runtime the full object is forwarded — enabling allow_fallbacks,
  // data_collection, ignore, sort, quantizations, etc.
  const providerRouting =
    provider === "openrouter" &&
    extraParams.provider != null &&
    typeof extraParams.provider === "object"
      ? (extraParams.provider as Record<string, unknown>)
      : undefined;

  if (Object.keys(streamParams).length === 0 && !providerRouting) {
    return undefined;
  }

  log.debug(`creating streamFn wrapper with params: ${JSON.stringify(streamParams)}`);
  if (providerRouting) {
    log.debug(`OpenRouter provider routing: ${JSON.stringify(providerRouting)}`);
  }

  const underlying = baseStreamFn ?? streamSimple;
  const wrappedStreamFn: StreamFn = (model, context, options) => {
    // When provider routing is configured, inject it into model.compat so
    // pi-ai picks it up via model.compat.openRouterRouting.
    const effectiveModel = providerRouting
      ? ({
          ...model,
          compat: { ...model.compat, openRouterRouting: providerRouting },
        } as unknown as typeof model)
      : model;
    return underlying(effectiveModel, context, {
      ...streamParams,
      ...options,
    });
  };

  return wrappedStreamFn;
}

function isAnthropicBedrockModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return normalized.includes("anthropic.claude") || normalized.includes("anthropic/claude");
}

function createBedrockNoCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      cacheRetention: "none",
    });
}

function isDirectOpenAIBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return true;
  }

  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.openai.com" || host === "chatgpt.com";
  } catch {
    const normalized = baseUrl.toLowerCase();
    return normalized.includes("api.openai.com") || normalized.includes("chatgpt.com");
  }
}

function shouldForceResponsesStore(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): boolean {
  if (typeof model.api !== "string" || typeof model.provider !== "string") {
    return false;
  }
  if (!OPENAI_RESPONSES_APIS.has(model.api)) {
    return false;
  }
  if (!OPENAI_RESPONSES_PROVIDERS.has(model.provider)) {
    return false;
  }
  return isDirectOpenAIBaseUrl(model.baseUrl);
}

function createOpenAIResponsesStoreWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!shouldForceResponsesStore(model)) {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          (payload as { store?: unknown }).store = true;
        }
        originalOnPayload?.(payload);
      },
    });
  };
}

function isAnthropic1MModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return ANTHROPIC_1M_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function parseHeaderList(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveAnthropicBetas(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
  modelId: string,
): string[] | undefined {
  if (provider !== "anthropic") {
    return undefined;
  }

  const betas = new Set<string>();
  const configured = extraParams?.anthropicBeta;
  if (typeof configured === "string" && configured.trim()) {
    betas.add(configured.trim());
  } else if (Array.isArray(configured)) {
    for (const beta of configured) {
      if (typeof beta === "string" && beta.trim()) {
        betas.add(beta.trim());
      }
    }
  }

  if (extraParams?.context1m === true) {
    if (isAnthropic1MModel(modelId)) {
      betas.add(ANTHROPIC_CONTEXT_1M_BETA);
    } else {
      log.warn(`ignoring context1m for non-opus/sonnet model: ${provider}/${modelId}`);
    }
  }

  return betas.size > 0 ? [...betas] : undefined;
}

function mergeAnthropicBetaHeader(
  headers: Record<string, string> | undefined,
  betas: string[],
): Record<string, string> {
  const merged = { ...headers };
  const existingKey = Object.keys(merged).find((key) => key.toLowerCase() === "anthropic-beta");
  const existing = existingKey ? parseHeaderList(merged[existingKey]) : [];
  const values = Array.from(new Set([...existing, ...betas]));
  const key = existingKey ?? "anthropic-beta";
  merged[key] = values.join(",");
  return merged;
}

// Betas that pi-ai's createClient injects for standard Anthropic API key calls.
// Must be included when injecting anthropic-beta via options.headers, because
// pi-ai's mergeHeaders uses Object.assign (last-wins), which would otherwise
// overwrite the hardcoded defaultHeaders["anthropic-beta"].
const PI_AI_DEFAULT_ANTHROPIC_BETAS = [
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
] as const;

// Additional betas pi-ai injects when the API key is an OAuth token (sk-ant-oat-*).
// These are required for Anthropic to accept OAuth Bearer auth. Losing oauth-2025-04-20
// causes a 401 "OAuth authentication is currently not supported".
const PI_AI_OAUTH_ANTHROPIC_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  ...PI_AI_DEFAULT_ANTHROPIC_BETAS,
] as const;

function isAnthropicOAuthApiKey(apiKey: unknown): boolean {
  return typeof apiKey === "string" && apiKey.includes("sk-ant-oat");
}

function createAnthropicBetaHeadersWrapper(
  baseStreamFn: StreamFn | undefined,
  betas: string[],
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const isOauth = isAnthropicOAuthApiKey(options?.apiKey);
    const requestedContext1m = betas.includes(ANTHROPIC_CONTEXT_1M_BETA);
    const effectiveBetas =
      isOauth && requestedContext1m
        ? betas.filter((beta) => beta !== ANTHROPIC_CONTEXT_1M_BETA)
        : betas;
    if (isOauth && requestedContext1m) {
      log.warn(
        `ignoring context1m for OAuth token auth on ${model.provider}/${model.id}; Anthropic rejects context-1m beta with OAuth auth`,
      );
    }

    // Preserve the betas pi-ai's createClient would inject for the given token type.
    // Without this, our options.headers["anthropic-beta"] overwrites the pi-ai
    // defaultHeaders via Object.assign, stripping critical betas like oauth-2025-04-20.
    const piAiBetas = isOauth
      ? (PI_AI_OAUTH_ANTHROPIC_BETAS as readonly string[])
      : (PI_AI_DEFAULT_ANTHROPIC_BETAS as readonly string[]);
    const allBetas = [...new Set([...piAiBetas, ...effectiveBetas])];
    return underlying(model, context, {
      ...options,
      headers: mergeAnthropicBetaHeader(options?.headers, allBetas),
    });
  };
}

function isOpenRouterAnthropicModel(provider: string, modelId: string): boolean {
  return provider.toLowerCase() === "openrouter" && modelId.toLowerCase().startsWith("anthropic/");
}

type PayloadMessage = {
  role?: string;
  content?: unknown;
};

/**
 * Inject cache_control into the system message for OpenRouter Anthropic models.
 * OpenRouter passes through Anthropic's cache_control field — caching the system
 * prompt avoids re-processing it on every request.
 */
function createOpenRouterSystemCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      typeof model.provider !== "string" ||
      typeof model.id !== "string" ||
      !isOpenRouterAnthropicModel(model.provider, model.id)
    ) {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        const messages = (payload as Record<string, unknown>)?.messages;
        if (Array.isArray(messages)) {
          for (const msg of messages as PayloadMessage[]) {
            if (msg.role !== "system" && msg.role !== "developer") {
              continue;
            }
            if (typeof msg.content === "string") {
              msg.content = [
                { type: "text", text: msg.content, cache_control: { type: "ephemeral" } },
              ];
            } else if (Array.isArray(msg.content) && msg.content.length > 0) {
              const last = msg.content[msg.content.length - 1];
              if (last && typeof last === "object") {
                (last as Record<string, unknown>).cache_control = { type: "ephemeral" };
              }
            }
          }
        }
        originalOnPayload?.(payload);
      },
    });
  };
}

/**
 * Map OpenClaw's ThinkLevel to OpenRouter's reasoning.effort values.
 * "off" maps to "none"; all other levels pass through as-is.
 */
function mapThinkingLevelToOpenRouterReasoningEffort(
  thinkingLevel: ThinkLevel,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  if (thinkingLevel === "off") {
    return "none";
  }
  return thinkingLevel;
}

function shouldApplySiliconFlowThinkingOffCompat(params: {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkLevel;
}): boolean {
  return (
    params.provider === "siliconflow" &&
    params.thinkingLevel === "off" &&
    params.modelId.startsWith("Pro/")
  );
}

/**
 * SiliconFlow's Pro/* models reject string thinking modes (including "off")
 * with HTTP 400 invalid-parameter errors. Normalize to `thinking: null` to
 * preserve "thinking disabled" intent without sending an invalid enum value.
 */
function createSiliconFlowThinkingWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          if (payloadObj.thinking === "off") {
            payloadObj.thinking = null;
          }
        }
        originalOnPayload?.(payload);
      },
    });
  };
}

/**
 * Create a streamFn wrapper that adds OpenRouter app attribution headers
 * and injects reasoning.effort based on the configured thinking level.
 */
function createOpenRouterWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const onPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      headers: {
        ...OPENROUTER_APP_HEADERS,
        ...options?.headers,
      },
      onPayload: (payload) => {
        if (thinkingLevel && payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;

          // pi-ai may inject a top-level reasoning_effort (OpenAI flat format).
          // OpenRouter expects the nested reasoning.effort format instead, and
          // rejects payloads containing both fields. Remove the flat field so
          // only the nested one is sent.
          delete payloadObj.reasoning_effort;

          // When thinking is "off", do not inject reasoning at all.
          // Some models (e.g. deepseek/deepseek-r1) require reasoning and reject
          // { effort: "none" } with "Reasoning is mandatory for this endpoint and
          // cannot be disabled." Omitting the field lets each model use its own
          // default reasoning behavior.
          if (thinkingLevel !== "off") {
            const existingReasoning = payloadObj.reasoning;

            // OpenRouter treats reasoning.effort and reasoning.max_tokens as
            // alternative controls. If max_tokens is already present, do not
            // inject effort and do not overwrite caller-supplied reasoning.
            if (
              existingReasoning &&
              typeof existingReasoning === "object" &&
              !Array.isArray(existingReasoning)
            ) {
              const reasoningObj = existingReasoning as Record<string, unknown>;
              if (!("max_tokens" in reasoningObj) && !("effort" in reasoningObj)) {
                reasoningObj.effort = mapThinkingLevelToOpenRouterReasoningEffort(thinkingLevel);
              }
            } else if (!existingReasoning) {
              payloadObj.reasoning = {
                effort: mapThinkingLevelToOpenRouterReasoningEffort(thinkingLevel),
              };
            }
          }
        }
        onPayload?.(payload);
      },
    });
  };
}

/**
 * Create a streamFn wrapper that injects tool_stream=true for Z.AI providers.
 *
 * Z.AI's API supports the `tool_stream` parameter to enable real-time streaming
 * of tool call arguments and reasoning content. When enabled, the API returns
 * progressive tool_call deltas, allowing users to see tool execution in real-time.
 *
 * @see https://docs.z.ai/api-reference#streaming
 */
function createZaiToolStreamWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!enabled) {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          // Inject tool_stream: true for Z.AI API
          (payload as Record<string, unknown>).tool_stream = true;
        }
        originalOnPayload?.(payload);
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
  const extraParams = resolveExtraParams({
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
  const merged = Object.assign({}, extraParams, override);
  const wrappedStreamFn = createStreamFnWithExtraParams(agent.streamFn, merged, provider);

  if (wrappedStreamFn) {
    log.debug(`applying extraParams to agent streamFn for ${provider}/${modelId}`);
    agent.streamFn = wrappedStreamFn;
  }

  const anthropicBetas = resolveAnthropicBetas(merged, provider, modelId);
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

  if (provider === "openrouter") {
    log.debug(`applying OpenRouter app attribution headers for ${provider}/${modelId}`);
    // "auto" is a dynamic routing model — we don't know which underlying model
    // OpenRouter will select, and it may be a reasoning-required endpoint.
    // Omit the thinkingLevel so we never inject `reasoning.effort: "none"`,
    // which would cause a 400 on models where reasoning is mandatory.
    // Users who need reasoning control should target a specific model ID.
    // See: openclaw/openclaw#24851
    const openRouterThinkingLevel = modelId === "auto" ? undefined : thinkingLevel;
    agent.streamFn = createOpenRouterWrapper(agent.streamFn, openRouterThinkingLevel);
    agent.streamFn = createOpenRouterSystemCacheWrapper(agent.streamFn);
  }

  if (provider === "amazon-bedrock" && !isAnthropicBedrockModel(modelId)) {
    log.debug(`disabling prompt caching for non-Anthropic Bedrock model ${provider}/${modelId}`);
    agent.streamFn = createBedrockNoCacheWrapper(agent.streamFn);
  }

  // Enable Z.AI tool_stream for real-time tool call streaming.
  // Enabled by default for Z.AI provider, can be disabled via params.tool_stream: false
  if (provider === "zai" || provider === "z-ai") {
    const toolStreamEnabled = merged?.tool_stream !== false;
    if (toolStreamEnabled) {
      log.debug(`enabling Z.AI tool_stream for ${provider}/${modelId}`);
      agent.streamFn = createZaiToolStreamWrapper(agent.streamFn, true);
    }
  }

  // Work around upstream pi-ai hardcoding `store: false` for Responses API.
  // Force `store=true` for direct OpenAI/OpenAI Codex providers so multi-turn
  // server-side conversation state is preserved.
  agent.streamFn = createOpenAIResponsesStoreWrapper(agent.streamFn);
}
