import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { resolveProviderAttributionHeaders } from "../provider-attribution.js";
import { log } from "./logger.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

type OpenAIServiceTier = "auto" | "default" | "flex" | "priority";
type OpenAIReasoningEffort = "low" | "medium" | "high";

const OPENAI_RESPONSES_APIS = new Set(["openai-responses"]);
const OPENAI_RESPONSES_PROVIDERS = new Set(["openai", "azure-openai", "azure-openai-responses"]);

function isDirectOpenAIBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return false;
  }

  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === "api.openai.com" || host === "chatgpt.com" || host.endsWith(".openai.azure.com")
    );
  } catch {
    const normalized = baseUrl.toLowerCase();
    return (
      normalized.includes("api.openai.com") ||
      normalized.includes("chatgpt.com") ||
      normalized.includes(".openai.azure.com")
    );
  }
}

function isOpenAIPublicApiBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return false;
  }

  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return baseUrl.toLowerCase().includes("api.openai.com");
  }
}

function isOpenAICodexBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return false;
  }

  try {
    return new URL(baseUrl).hostname.toLowerCase() === "chatgpt.com";
  } catch {
    return baseUrl.toLowerCase().includes("chatgpt.com");
  }
}

function shouldApplyOpenAIAttributionHeaders(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): "openai" | "openai-codex" | undefined {
  if (
    model.provider === "openai" &&
    (model.api === "openai-completions" || model.api === "openai-responses") &&
    isOpenAIPublicApiBaseUrl(model.baseUrl)
  ) {
    return "openai";
  }
  if (
    model.provider === "openai-codex" &&
    (model.api === "openai-codex-responses" || model.api === "openai-responses") &&
    isOpenAICodexBaseUrl(model.baseUrl)
  ) {
    return "openai-codex";
  }
  return undefined;
}

function shouldForceResponsesStore(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
  compat?: { supportsStore?: boolean };
}): boolean {
  if (model.compat?.supportsStore === false) {
    return false;
  }
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

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function resolveOpenAIResponsesCompactThreshold(model: { contextWindow?: unknown }): number {
  const contextWindow = parsePositiveInteger(model.contextWindow);
  if (contextWindow) {
    return Math.max(1_000, Math.floor(contextWindow * 0.7));
  }
  return 80_000;
}

function shouldEnableOpenAIResponsesServerCompaction(
  model: {
    api?: unknown;
    provider?: unknown;
    baseUrl?: unknown;
    compat?: { supportsStore?: boolean };
  },
  extraParams: Record<string, unknown> | undefined,
): boolean {
  const configured = extraParams?.responsesServerCompaction;
  if (configured === false) {
    return false;
  }
  if (!shouldForceResponsesStore(model)) {
    return false;
  }
  if (configured === true) {
    return true;
  }
  return model.provider === "openai";
}

function shouldStripResponsesStore(
  model: { api?: unknown; compat?: { supportsStore?: boolean } },
  forceStore: boolean,
): boolean {
  if (forceStore) {
    return false;
  }
  if (typeof model.api !== "string") {
    return false;
  }
  return OPENAI_RESPONSES_APIS.has(model.api) && model.compat?.supportsStore === false;
}

function applyOpenAIResponsesPayloadOverrides(params: {
  payloadObj: Record<string, unknown>;
  forceStore: boolean;
  stripStore: boolean;
  useServerCompaction: boolean;
  compactThreshold: number;
}): void {
  if (params.forceStore) {
    params.payloadObj.store = true;
  }
  if (params.stripStore) {
    delete params.payloadObj.store;
  }
  if (params.useServerCompaction && params.payloadObj.context_management === undefined) {
    params.payloadObj.context_management = [
      {
        type: "compaction",
        compact_threshold: params.compactThreshold,
      },
    ];
  }
}

function normalizeOpenAIServiceTier(value: unknown): OpenAIServiceTier | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "default" ||
    normalized === "flex" ||
    normalized === "priority"
  ) {
    return normalized;
  }
  return undefined;
}

export function resolveOpenAIServiceTier(
  extraParams: Record<string, unknown> | undefined,
): OpenAIServiceTier | undefined {
  const raw = extraParams?.serviceTier ?? extraParams?.service_tier;
  const normalized = normalizeOpenAIServiceTier(raw);
  if (raw !== undefined && normalized === undefined) {
    const rawSummary = typeof raw === "string" ? raw : typeof raw;
    log.warn(`ignoring invalid OpenAI service tier param: ${rawSummary}`);
  }
  return normalized;
}

function normalizeOpenAIFastMode(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "on" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "1" ||
    normalized === "fast"
  ) {
    return true;
  }
  if (
    normalized === "off" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "0" ||
    normalized === "normal"
  ) {
    return false;
  }
  return undefined;
}

export function resolveOpenAIFastMode(
  extraParams: Record<string, unknown> | undefined,
): boolean | undefined {
  const raw = extraParams?.fastMode ?? extraParams?.fast_mode;
  const normalized = normalizeOpenAIFastMode(raw);
  if (raw !== undefined && normalized === undefined) {
    const rawSummary = typeof raw === "string" ? raw : typeof raw;
    log.warn(`ignoring invalid OpenAI fast mode param: ${rawSummary}`);
  }
  return normalized;
}

function resolveFastModeReasoningEffort(modelId: unknown): OpenAIReasoningEffort {
  if (typeof modelId !== "string") {
    return "low";
  }
  const normalized = modelId.trim().toLowerCase();
  // Keep fast mode broadly compatible across GPT-5 family variants by using
  // the lowest shared non-disabled effort that current transports accept.
  if (normalized.startsWith("gpt-5")) {
    return "low";
  }
  return "low";
}

function applyOpenAIFastModePayloadOverrides(params: {
  payloadObj: Record<string, unknown>;
  model: { provider?: unknown; id?: unknown; baseUrl?: unknown; api?: unknown };
}): void {
  if (params.payloadObj.reasoning === undefined) {
    params.payloadObj.reasoning = {
      effort: resolveFastModeReasoningEffort(params.model.id),
    };
  }

  const existingText = params.payloadObj.text;
  if (existingText === undefined) {
    params.payloadObj.text = { verbosity: "low" };
  } else if (existingText && typeof existingText === "object" && !Array.isArray(existingText)) {
    const textObj = existingText as Record<string, unknown>;
    if (textObj.verbosity === undefined) {
      textObj.verbosity = "low";
    }
  }

  if (
    params.model.provider === "openai" &&
    params.payloadObj.service_tier === undefined &&
    isOpenAIPublicApiBaseUrl(params.model.baseUrl)
  ) {
    params.payloadObj.service_tier = "priority";
  }
}

export function createOpenAIResponsesContextManagementWrapper(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const forceStore = shouldForceResponsesStore(model);
    const useServerCompaction = shouldEnableOpenAIResponsesServerCompaction(model, extraParams);
    const stripStore = shouldStripResponsesStore(model, forceStore);
    if (!forceStore && !useServerCompaction && !stripStore) {
      return underlying(model, context, options);
    }

    const compactThreshold =
      parsePositiveInteger(extraParams?.responsesCompactThreshold) ??
      resolveOpenAIResponsesCompactThreshold(model);
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          applyOpenAIResponsesPayloadOverrides({
            payloadObj: payload as Record<string, unknown>,
            forceStore,
            stripStore,
            useServerCompaction,
            compactThreshold,
          });
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

export function createOpenAIFastModeWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      (model.api !== "openai-responses" && model.api !== "openai-codex-responses") ||
      (model.provider !== "openai" && model.provider !== "openai-codex")
    ) {
      return underlying(model, context, options);
    }
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          applyOpenAIFastModePayloadOverrides({
            payloadObj: payload as Record<string, unknown>,
            model,
          });
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

export function createOpenAIServiceTierWrapper(
  baseStreamFn: StreamFn | undefined,
  serviceTier: OpenAIServiceTier,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      model.api !== "openai-responses" ||
      model.provider !== "openai" ||
      !isOpenAIPublicApiBaseUrl(model.baseUrl)
    ) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      if (payloadObj.service_tier === undefined) {
        payloadObj.service_tier = serviceTier;
      }
    });
  };
}

export function createCodexDefaultTransportWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      transport: options?.transport ?? "auto",
    });
}

export function createOpenAIDefaultTransportWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const typedOptions = options as
      | (SimpleStreamOptions & { openaiWsWarmup?: boolean })
      | undefined;
    const mergedOptions = {
      ...options,
      transport: options?.transport ?? "auto",
      openaiWsWarmup: typedOptions?.openaiWsWarmup ?? false,
    } as SimpleStreamOptions;
    return underlying(model, context, mergedOptions);
  };
}

export function createOpenAIAttributionHeadersWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const attributionProvider = shouldApplyOpenAIAttributionHeaders(model);
    if (!attributionProvider) {
      return underlying(model, context, options);
    }
    return underlying(model, context, {
      ...options,
      headers: {
        ...options?.headers,
        ...resolveProviderAttributionHeaders(attributionProvider),
      },
    });
  };
}

/**
 * Normalize usage field names in an SSE JSON data line.
 *
 * Some OpenAI-compatible servers (mlx-vlm, vLLM) return `input_tokens` /
 * `output_tokens` instead of the standard `prompt_tokens` / `completion_tokens`.
 * The upstream pi-ai `parseChunkUsage` only reads the standard field names, so
 * usage ends up as zero.  This function adds the standard field names when they
 * are absent but the alternatives are present, so pi-ai can read them.
 */
function normalizeUsageFieldsInSseJson(json: string): string {
  // Fast-path: skip lines that don't contain a usage object.
  if (!json.includes('"usage"')) {
    return json;
  }

  try {
    const obj = JSON.parse(json);
    const usage = obj?.usage;
    if (!usage || typeof usage !== "object") {
      return json;
    }

    let patched = false;

    // Add prompt_tokens from input_tokens when prompt_tokens is absent.
    if (
      usage.prompt_tokens === undefined &&
      typeof usage.input_tokens === "number" &&
      Number.isFinite(usage.input_tokens)
    ) {
      usage.prompt_tokens = usage.input_tokens;
      patched = true;
    }

    // Add completion_tokens from output_tokens when completion_tokens is absent.
    if (
      usage.completion_tokens === undefined &&
      typeof usage.output_tokens === "number" &&
      Number.isFinite(usage.output_tokens)
    ) {
      usage.completion_tokens = usage.output_tokens;
      patched = true;
    }

    if (!patched) {
      return json;
    }

    return JSON.stringify(obj);
  } catch {
    // Not valid JSON — pass through unchanged.
    return json;
  }
}

/**
 * Wrap a fetch Response so that SSE `data:` lines have their usage field names
 * normalized before the OpenAI SDK parses them.
 */
function wrapSseResponse(original: Response): Response {
  const body = original.body;
  if (!body) {
    return original;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last (possibly incomplete) line in the buffer.
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("data: ") && !line.startsWith("data: [DONE]")) {
          const jsonPart = line.slice(6);
          const normalized = normalizeUsageFieldsInSseJson(jsonPart);
          controller.enqueue(encoder.encode(`data: ${normalized}\n`));
        } else {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        if (buffer.startsWith("data: ") && !buffer.startsWith("data: [DONE]")) {
          const jsonPart = buffer.slice(6);
          const normalized = normalizeUsageFieldsInSseJson(jsonPart);
          controller.enqueue(encoder.encode(`data: ${normalized}\n`));
        } else {
          controller.enqueue(encoder.encode(`${buffer}\n`));
        }
      }
    },
  });

  const transformedBody = body.pipeThrough(transform);

  return new Response(transformedBody, {
    status: original.status,
    statusText: original.statusText,
    headers: original.headers,
  });
}

/**
 * Number of active callers that need the normalizing fetch wrapper installed.
 * When it drops to zero, we restore the original fetch.
 */
let normalizingFetchRefCount = 0;
let originalFetch: typeof globalThis.fetch | undefined;

function installNormalizingFetch(): void {
  normalizingFetchRefCount += 1;
  if (normalizingFetchRefCount === 1) {
    originalFetch = globalThis.fetch;
    const savedFetch = originalFetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await savedFetch(input, init);
      const contentType = response.headers.get("content-type") ?? "";
      // Only wrap SSE streaming responses from chat completion endpoints.
      if (contentType.includes("text/event-stream")) {
        return wrapSseResponse(response);
      }
      return response;
    };
  }
}

function uninstallNormalizingFetch(): void {
  normalizingFetchRefCount -= 1;
  if (normalizingFetchRefCount <= 0) {
    normalizingFetchRefCount = 0;
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = undefined;
    }
  }
}

/**
 * StreamFn wrapper that normalizes `input_tokens`/`output_tokens` →
 * `prompt_tokens`/`completion_tokens` in SSE streaming responses from
 * OpenAI-compatible servers (mlx-vlm, vLLM, etc.).
 *
 * The upstream pi-ai openai-completions provider only reads the standard
 * OpenAI field names, so alternative servers that use Anthropic-style names
 * report zero usage.  This wrapper intercepts the HTTP response via a scoped
 * globalThis.fetch override and adds the missing standard field names before
 * the OpenAI SDK and pi-ai parse the SSE data.
 */
export function createOpenAICompletionsUsageNormalizationWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    // Only apply to openai-completions API which uses the OpenAI SDK streaming.
    if (model.api !== "openai-completions") {
      return underlying(model, context, options);
    }

    installNormalizingFetch();

    const maybeStream = underlying(model, context, options);

    // The underlying StreamFn may return a Promise or the stream directly.
    // In either case, hook into the stream's result() to uninstall when done.
    const hookCleanup = (stream: ReturnType<typeof streamSimple>) => {
      const originalResult = stream.result.bind(stream);
      stream.result = async () => {
        try {
          return await originalResult();
        } finally {
          uninstallNormalizingFetch();
        }
      };
      return stream;
    };

    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) => hookCleanup(stream));
    }

    return hookCleanup(maybeStream);
  };
}
