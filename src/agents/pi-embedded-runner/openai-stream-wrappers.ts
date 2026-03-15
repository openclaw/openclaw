import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
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

/**
 * JSON-unsafe control characters: U+0000–U+0008, U+000B, U+000C, U+000E–U+001F, U+007F.
 * Preserves tab (0x09), newline (0x0A), and carriage return (0x0D).
 */
// eslint-disable-next-line no-control-regex
const JSON_UNSAFE_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Fields set by pi-ai's openai-completions provider when replaying reasoning
 * content from models like Qwen 3.5.  The provider stores the field name
 * (e.g. "reasoning_content") in `thinkingSignature` and later writes it as a
 * dynamic key on the assistant message.  The raw content may contain control
 * characters that cause strict JSON parsers (oMLX / FastAPI / Pydantic) to
 * reject the request body with a 422 "JSON decode error".
 */
const REASONING_CONTENT_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"];

function stripJsonUnsafeControlChars(value: string): string {
  return value.replace(JSON_UNSAFE_CONTROL_RE, "");
}

/**
 * Sanitize reasoning content fields on assistant messages in the outbound
 * payload to prevent JSON parse errors on strict OpenAI-compatible servers.
 *
 * This is applied as an `onPayload` wrapper so it runs right before the
 * request body is serialized, regardless of which upstream stream function
 * constructed the payload.
 */
export function createReasoningContentSanitizer(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          sanitizeReasoningContentInPayload(payload as Record<string, unknown>);
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

function sanitizeReasoningContentInPayload(payload: Record<string, unknown>): void {
  const messages = payload.messages;
  if (!Array.isArray(messages)) {
    return;
  }
  for (const msg of messages as Array<Record<string, unknown>>) {
    if (!msg || typeof msg !== "object" || msg.role !== "assistant") {
      continue;
    }
    for (const field of REASONING_CONTENT_FIELDS) {
      const value = msg[field];
      if (typeof value !== "string") {
        continue;
      }
      const sanitized = stripJsonUnsafeControlChars(value);
      if (sanitized !== value) {
        msg[field] = sanitized;
      }
    }
  }
}
