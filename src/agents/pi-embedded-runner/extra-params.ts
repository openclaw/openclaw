import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { log } from "./logger.js";

const OPENROUTER_APP_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-Title": "OpenClaw",
};
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

function mergeExtraParams(
  extraParams: Record<string, unknown> | undefined,
  extraParamsOverride?: Record<string, unknown>,
): Record<string, unknown> {
  const override =
    extraParamsOverride && Object.keys(extraParamsOverride).length > 0
      ? Object.fromEntries(
          Object.entries(extraParamsOverride).filter(([, value]) => value !== undefined),
        )
      : undefined;
  return Object.assign({}, extraParams, override);
}

function parseBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function parseStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }
  if (typeof value === "string") {
    const normalized = value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }
  return undefined;
}

type OpenRouterRoutingOverrides = {
  data_collection?: "allow" | "deny";
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  only?: string[];
  order?: string[];
};

/**
 * Resolve OpenRouter-compatible provider routing overrides from extra params.
 * These are injected into OpenAI-compatible payloads as `provider: {...}`.
 *
 * Supported keys:
 * - `openrouterDataCollection` ("allow" | "deny")
 * - `openrouterAllowFallbacks` (boolean)
 * - `openrouterRequireParameters` (boolean)
 * - `openrouterProviderOnly` (string[] or comma-separated string)
 * - `openrouterProviderOrder` (string[] or comma-separated string)
 *
 * @internal Exported for testing only
 */
export function resolveOpenRouterRoutingFromExtraParams(
  extraParams: Record<string, unknown> | undefined,
): OpenRouterRoutingOverrides | undefined {
  if (!extraParams || Object.keys(extraParams).length === 0) {
    return undefined;
  }

  const routing: OpenRouterRoutingOverrides = {};

  const dataCollectionRaw =
    extraParams.openrouterDataCollection ?? extraParams.openRouterDataCollection;
  if (typeof dataCollectionRaw === "string") {
    const normalized = dataCollectionRaw.trim().toLowerCase();
    if (normalized === "allow" || normalized === "deny") {
      routing.data_collection = normalized;
    }
  }

  const allowFallbacks = parseBooleanFlag(
    extraParams.openrouterAllowFallbacks ?? extraParams.openRouterAllowFallbacks,
  );
  if (allowFallbacks !== undefined) {
    routing.allow_fallbacks = allowFallbacks;
  }

  const requireParameters = parseBooleanFlag(
    extraParams.openrouterRequireParameters ?? extraParams.openRouterRequireParameters,
  );
  if (requireParameters !== undefined) {
    routing.require_parameters = requireParameters;
  }

  const providerOnly = parseStringList(
    extraParams.openrouterProviderOnly ?? extraParams.openRouterProviderOnly,
  );
  if (providerOnly && providerOnly.length > 0) {
    routing.only = providerOnly;
  }

  const providerOrder = parseStringList(
    extraParams.openrouterProviderOrder ?? extraParams.openRouterProviderOrder,
  );
  if (providerOrder && providerOrder.length > 0) {
    routing.order = providerOrder;
  }

  return Object.keys(routing).length > 0 ? routing : undefined;
}

/**
 * Resolve per-model tool toggle from extra params (`params.disableTools`).
 *
 * @internal Exported for testing only
 */
export function resolveDisableToolsFromExtraParams(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  extraParamsOverride?: Record<string, unknown>;
}): boolean | undefined {
  const extraParams = resolveExtraParams({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
  });
  const merged = mergeExtraParams(extraParams, params.extraParamsOverride);
  return parseBooleanFlag(merged.disableTools);
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

function isOpenRouterLikeModel(model: {
  api?: string;
  provider?: string;
  baseUrl?: string;
}): boolean {
  if (model.api !== "openai-completions") {
    return false;
  }
  const provider = (model.provider ?? "").toLowerCase();
  if (provider === "openrouter" || provider === "kilo") {
    return true;
  }
  const baseUrl = (model.baseUrl ?? "").toLowerCase();
  return baseUrl.includes("openrouter.ai") || baseUrl.includes("kilo.ai");
}

/**
 * Inject provider-routing overrides into OpenRouter-compatible payloads.
 */
function createOpenRouterRoutingWrapper(
  baseStreamFn: StreamFn | undefined,
  routing: OpenRouterRoutingOverrides,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const modelInfo = model as { api?: string; provider?: string; baseUrl?: string };
    if (!isOpenRouterLikeModel(modelInfo)) {
      return underlying(model, context, options);
    }

    const previousOnPayload = options?.onPayload;
    const onPayload = (payload: unknown) => {
      if (payload && typeof payload === "object") {
        const body = payload as Record<string, unknown>;
        const existingProvider =
          body.provider && typeof body.provider === "object" && !Array.isArray(body.provider)
            ? (body.provider as Record<string, unknown>)
            : {};
        body.provider = {
          ...existingProvider,
          ...routing,
        };
      }
      previousOnPayload?.(payload);
    };

    return underlying(model, context, {
      ...options,
      onPayload,
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
  const merged = mergeExtraParams(extraParams, extraParamsOverride);
  const wrappedStreamFn = createStreamFnWithExtraParams(agent.streamFn, merged, provider);

  if (wrappedStreamFn) {
    log.debug(`applying extraParams to agent streamFn for ${provider}/${modelId}`);
    agent.streamFn = wrappedStreamFn;
  }

  const openRouterRouting = resolveOpenRouterRoutingFromExtraParams(merged);
  if (openRouterRouting) {
    log.debug(`applying OpenRouter routing overrides for ${provider}/${modelId}`);
    agent.streamFn = createOpenRouterRoutingWrapper(agent.streamFn, openRouterRouting);
  }

  if (provider === "openrouter") {
    log.debug(`applying OpenRouter app attribution headers for ${provider}/${modelId}`);
    agent.streamFn = createOpenRouterHeadersWrapper(agent.streamFn);
  }

  // Work around upstream pi-ai hardcoding `store: false` for Responses API.
  // Force `store=true` for direct OpenAI/OpenAI Codex providers so multi-turn
  // server-side conversation state is preserved.
  agent.streamFn = createOpenAIResponsesStoreWrapper(agent.streamFn);
}
