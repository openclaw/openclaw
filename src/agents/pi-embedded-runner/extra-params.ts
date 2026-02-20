import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
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
 *
 * Defaults to "short" for Anthropic provider when not explicitly configured.
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

  // Default to "long" for Anthropic when not explicitly configured.
  // OpenClaw always enables the extended-cache-ttl-2025-04-11 beta, so
  // { type: "ephemeral" } defaults to 1h. Using "long" aligns the explicit
  // cacheRetention value with what the beta already provides.
  return "long";
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
    // Preserve the betas pi-ai's createClient would inject for the given token type.
    // Without this, our options.headers["anthropic-beta"] overwrites the pi-ai
    // defaultHeaders via Object.assign, stripping critical betas like oauth-2025-04-20.
    const piAiBetas = isAnthropicOAuthApiKey(options?.apiKey)
      ? (PI_AI_OAUTH_ANTHROPIC_BETAS as readonly string[])
      : (PI_AI_DEFAULT_ANTHROPIC_BETAS as readonly string[]);
    const allBetas = [...new Set([...piAiBetas, ...betas])];
    return underlying(model, context, {
      ...options,
      headers: mergeAnthropicBetaHeader(options?.headers, allBetas),
    });
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

// ---------------------------------------------------------------------------
// Conversation history cache markers
// ---------------------------------------------------------------------------

type AnthropicContentBlock = {
  type?: string;
  text?: string;
  cache_control?: { type: string; ttl?: string };
  [key: string]: unknown;
};

type AnthropicPayloadMessage = {
  role?: string;
  content?: string | AnthropicContentBlock[];
  [key: string]: unknown;
};

const DEFAULT_CONVERSATION_CACHE_TAIL = 30;
const MIN_STABLE_MESSAGES = 20;
// Anthropic's hard limit on cache_control blocks per request (across system, tools, messages).
const ANTHROPIC_MAX_CACHE_BLOCKS = 4;
// Maximum conversation history markers we want to place (advisory ceiling, not the hard limit).
// The actual number placed is capped by remaining slots after counting existing blocks.
const MAX_CONVERSATION_CACHE_MARKERS = 2;

/**
 * Resolve `cacheConversationTail` from extra params.
 *
 * - Explicit number → use that value (0 disables); invalid values (NaN, Infinity, negative) fall back to default
 * - `undefined` when `cacheRetention` is set (or defaults to "long") → default to 30
 * - Non-Anthropic provider → always undefined (disabled)
 */
function resolveConversationCacheTail(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): number | undefined {
  if (provider !== "anthropic") {
    return undefined;
  }

  const explicit = extraParams?.cacheConversationTail;
  if (typeof explicit === "number") {
    if (!Number.isFinite(explicit) || explicit < 0) {
      log.warn(
        `ignoring invalid cacheConversationTail value: ${String(explicit)}; using default ${DEFAULT_CONVERSATION_CACHE_TAIL}`,
      );
      return DEFAULT_CONVERSATION_CACHE_TAIL;
    }
    return Math.trunc(explicit);
  }

  // Auto-enable when cacheRetention is explicitly active (any value except "none").
  //
  // IMPORTANT: do NOT auto-enable when retention is undefined (model not in config).
  // When cacheRetention is not explicitly set, createStreamFnWithExtraParams may
  // return early without passing cacheRetention to pi-ai. pi-ai then defaults to
  // "short", placing { type: "ephemeral" } (5m) on system/last-user-message blocks.
  // Our conversation markers use ttl="1h", which would violate Anthropic's ordering
  // rule (longer TTL must come first: tools → system → messages).
  const retention = extraParams?.cacheRetention;
  if (retention && retention !== "none") {
    return DEFAULT_CONVERSATION_CACHE_TAIL;
  }

  return undefined;
}

/**
 * Add up to `maxMarkers` `cache_control` markers to the stable portion of
 * conversation messages. The last `tailCount` messages are kept uncached
 * (hot zone) while the older stable history is divided into equal segments
 * with cache breakpoints.
 *
 * Anthropic allows 4 `cache_control` blocks per request total (across system,
 * tools, and messages). The caller is responsible for computing how many slots
 * remain after pi-ai has already placed its own blocks (system prompt, last
 * user message, etc.) and passing that count as `maxMarkers`.
 *
 * The `cacheTtl` must match the TTL used by the system-prompt cache markers to
 * satisfy Anthropic's ordering requirement (longer TTLs must appear before shorter
 * ones when processed in tools → system → messages order).
 *
 * @param messages   - The Anthropic API messages array (mutated in-place)
 * @param tailCount  - Number of recent messages to leave uncached (default 30)
 * @param minStable  - Minimum stable messages required before placing markers (default 20)
 * @param cacheTtl   - Explicit TTL for the cache_control blocks ("5m" | "1h"). Must
 *                     match the session's cacheRetention setting to avoid TTL ordering
 *                     violations. Defaults to "1h" to align with the extended-cache-ttl
 *                     beta that OpenClaw enables by default.
 * @param maxMarkers - Maximum number of markers to place (default MAX_CONVERSATION_CACHE_MARKERS).
 *                     Should be set to the number of remaining cache block slots so we
 *                     never exceed Anthropic's 4-block limit.
 * @returns The messages array (same reference, mutated)
 *
 * @internal Exported for testing
 */
export function addConversationCacheMarkers(
  messages: AnthropicPayloadMessage[],
  tailCount: number = DEFAULT_CONVERSATION_CACHE_TAIL,
  minStable: number = MIN_STABLE_MESSAGES,
  cacheTtl: "5m" | "1h" = "1h",
  maxMarkers: number = MAX_CONVERSATION_CACHE_MARKERS,
): AnthropicPayloadMessage[] {
  const stableCutoff = Math.max(0, messages.length - tailCount);
  if (stableCutoff < minStable) {
    return messages;
  }

  const markersToPlace = Math.min(maxMarkers, Math.floor(stableCutoff / minStable));
  if (markersToPlace === 0) {
    return messages;
  }

  for (let i = 1; i <= markersToPlace; i++) {
    const idx = Math.floor((stableCutoff * i) / markersToPlace) - 1;
    if (idx < 0 || idx >= messages.length) {
      continue;
    }

    const msg = messages[idx];
    if (!msg) {
      continue;
    }

    // Normalise string content → content block array so we can attach cache_control
    if (typeof msg.content === "string") {
      msg.content = [{ type: "text", text: msg.content }];
    }

    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const lastBlock = msg.content[msg.content.length - 1];
      if (lastBlock && typeof lastBlock === "object") {
        lastBlock.cache_control = { type: "ephemeral", ttl: cacheTtl };
      }
    }
  }

  return messages;
}

/**
 * Count all `cache_control` blocks already present in an Anthropic API payload
 * (across system blocks, tool definitions, and message content blocks).
 *
 * Used to determine how many slots remain before Anthropic's 4-block hard limit,
 * so we can add exactly the right number of conversation history markers without
 * exceeding the cap regardless of how many blocks the upstream (pi-ai) placed.
 *
 * @internal Exported for testing
 */
export function countExistingCacheBlocks(payload: Record<string, unknown>): number {
  let count = 0;

  // System blocks
  const system = payload.system;
  if (Array.isArray(system)) {
    for (const block of system) {
      if (block && typeof block === "object" && (block as AnthropicContentBlock).cache_control) {
        count++;
      }
    }
  }

  // Tool definitions (last tool can carry cache_control in some configurations)
  const tools = payload.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool && typeof tool === "object" && (tool as AnthropicContentBlock).cache_control) {
        count++;
      }
    }
  }

  // Message content blocks
  const messages = payload.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages as AnthropicPayloadMessage[]) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && block.cache_control) {
            count++;
          }
        }
      }
    }
  }

  return count;
}

/**
 * Create a streamFn wrapper that injects conversation history cache markers
 * into the Anthropic API payload via `onPayload`.
 *
 * Dynamically counts cache_control blocks already present in the payload
 * (placed by pi-ai for system prompt, last user message, etc.) and fills
 * only the remaining slots up to Anthropic's 4-block hard limit. This makes
 * the feature robust to changes in pi-ai's caching behaviour and to different
 * auth modes (API key vs OAuth, which add 1 vs 2 system blocks).
 *
 * The `cacheTtl` must match the session's `cacheRetention` setting to avoid
 * Anthropic TTL ordering violations (tools → system → messages must be
 * longest-TTL-first when the extended-cache-ttl beta is active).
 */
function createConversationCacheMarkersWrapper(
  baseStreamFn: StreamFn | undefined,
  tailCount: number,
  cacheTtl: "5m" | "1h",
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const p = payload as { messages?: AnthropicPayloadMessage[] };
          if (Array.isArray(p.messages)) {
            const existingBlocks = countExistingCacheBlocks(payload as Record<string, unknown>);
            const availableSlots = Math.max(0, ANTHROPIC_MAX_CACHE_BLOCKS - existingBlocks);
            const effectiveMax = Math.min(MAX_CONVERSATION_CACHE_MARKERS, availableSlots);
            if (effectiveMax > 0) {
              addConversationCacheMarkers(
                p.messages,
                tailCount,
                MIN_STABLE_MESSAGES,
                cacheTtl,
                effectiveMax,
              );
            }
          }
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

  const anthropicBetas = resolveAnthropicBetas(merged, provider, modelId);
  if (anthropicBetas?.length) {
    log.debug(
      `applying Anthropic beta header for ${provider}/${modelId}: ${anthropicBetas.join(",")}`,
    );
    agent.streamFn = createAnthropicBetaHeadersWrapper(agent.streamFn, anthropicBetas);
  }

  if (provider === "openrouter") {
    log.debug(`applying OpenRouter app attribution headers for ${provider}/${modelId}`);
    agent.streamFn = createOpenRouterHeadersWrapper(agent.streamFn);
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

  // Conversation history caching: place up to 2 cache markers on the stable
  // portion of message history to avoid re-processing long conversations.
  // TTL must match the session cacheRetention to satisfy Anthropic's ordering
  // requirement (tools → system → messages must be longest-TTL-first).
  const conversationTail = resolveConversationCacheTail(merged, provider);
  if (typeof conversationTail === "number" && conversationTail !== 0) {
    const retention = resolveCacheRetention(merged, provider);
    const cacheTtl: "5m" | "1h" = retention === "short" ? "5m" : "1h";
    log.debug(
      `enabling conversation cache markers for ${provider}/${modelId} (tail=${conversationTail}, ttl=${cacheTtl})`,
    );
    agent.streamFn = createConversationCacheMarkersWrapper(
      agent.streamFn,
      conversationTail,
      cacheTtl,
    );
  }

  // Work around upstream pi-ai hardcoding `store: false` for Responses API.
  // Force `store=true` for direct OpenAI/OpenAI Codex providers so multi-turn
  // server-side conversation state is preserved.
  agent.streamFn = createOpenAIResponsesStoreWrapper(agent.streamFn);
}
