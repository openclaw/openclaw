import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import {
  patchCodexNativeWebSearchPayload,
  resolveCodexNativeSearchActivation,
} from "../codex-native-web-search.js";
import { resolveProviderRequestPolicyConfig } from "../provider-request-config.js";
import { log } from "./logger.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

type OpenAIServiceTier = "auto" | "default" | "flex" | "priority";
type OpenAITextVerbosity = "low" | "medium" | "high";

const OPENAI_RESPONSES_APIS = new Set(["openai-responses", "azure-openai-responses"]);

function resolveOpenAIRequestCapabilities(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
  compat?: { supportsStore?: boolean };
}) {
  return resolveProviderRequestPolicyConfig({
    provider: typeof model.provider === "string" ? model.provider : undefined,
    api: typeof model.api === "string" ? model.api : undefined,
    baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
    compat: model.compat,
    capability: "llm",
    transport: "stream",
  }).capabilities;
}

function shouldApplyOpenAIAttributionHeaders(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): "openai" | "openai-codex" | undefined {
  const attributionProvider = resolveOpenAIRequestCapabilities(model).attributionProvider;
  return attributionProvider === "openai" || attributionProvider === "openai-codex"
    ? attributionProvider
    : undefined;
}

function shouldApplyOpenAIServiceTier(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): boolean {
  return resolveOpenAIRequestCapabilities(model).allowsOpenAIServiceTier;
}

function shouldForceResponsesStore(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
  compat?: { supportsStore?: boolean };
}): boolean {
  return resolveOpenAIRequestCapabilities(model).allowsResponsesStore;
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

function shouldStripResponsesPromptCache(model: { api?: unknown; baseUrl?: unknown }): boolean {
  return resolveOpenAIRequestCapabilities(model).shouldStripResponsesPromptCache;
}

function shouldApplyOpenAIReasoningCompatibility(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): boolean {
  if (typeof model.api !== "string" || typeof model.provider !== "string") {
    return false;
  }
  return resolveOpenAIRequestCapabilities(model).supportsOpenAIReasoningCompatPayload;
}

function stripDisabledOpenAIReasoningPayload(payloadObj: Record<string, unknown>): void {
  const reasoning = payloadObj.reasoning;
  if (reasoning === "none") {
    delete payloadObj.reasoning;
    return;
  }
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) {
    return;
  }

  // GPT-5 models reject `reasoning.effort: "none"`. Treat the disabled effort
  // as "reasoning omitted" instead of forwarding an unsupported value.
  const reasoningObj = reasoning as Record<string, unknown>;
  if (reasoningObj.effort === "none") {
    delete payloadObj.reasoning;
  }
}

function applyOpenAIResponsesPayloadOverrides(params: {
  payloadObj: Record<string, unknown>;
  forceStore: boolean;
  stripStore: boolean;
  stripPromptCache: boolean;
  useServerCompaction: boolean;
  compactThreshold: number;
}): void {
  if (params.forceStore) {
    params.payloadObj.store = true;
  }
  if (params.stripStore) {
    delete params.payloadObj.store;
  }
  if (params.stripPromptCache) {
    delete params.payloadObj.prompt_cache_key;
    delete params.payloadObj.prompt_cache_retention;
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

function normalizeOpenAITextVerbosity(value: unknown): OpenAITextVerbosity | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return undefined;
}

export function resolveOpenAITextVerbosity(
  extraParams: Record<string, unknown> | undefined,
): OpenAITextVerbosity | undefined {
  const raw = extraParams?.textVerbosity ?? extraParams?.text_verbosity;
  const normalized = normalizeOpenAITextVerbosity(raw);
  if (raw !== undefined && normalized === undefined) {
    const rawSummary = typeof raw === "string" ? raw : typeof raw;
    log.warn(`ignoring invalid OpenAI text verbosity param: ${rawSummary}`);
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

function applyOpenAIFastModePayloadOverrides(params: {
  payloadObj: Record<string, unknown>;
  model: { provider?: unknown; id?: unknown; baseUrl?: unknown; api?: unknown };
}): void {
  if (params.payloadObj.service_tier === undefined && shouldApplyOpenAIServiceTier(params.model)) {
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
    const stripPromptCache = shouldStripResponsesPromptCache(model);
    if (!forceStore && !useServerCompaction && !stripStore && !stripPromptCache) {
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
            stripPromptCache,
            useServerCompaction,
            compactThreshold,
          });
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

export function createOpenAIReasoningCompatibilityWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!shouldApplyOpenAIReasoningCompatibility(model)) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      stripDisabledOpenAIReasoningPayload(payloadObj);
    });
  };
}

export function createOpenAIFastModeWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      (model.api !== "openai-responses" &&
        model.api !== "openai-codex-responses" &&
        model.api !== "azure-openai-responses") ||
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
    if (!shouldApplyOpenAIServiceTier(model)) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      if (payloadObj.service_tier === undefined) {
        payloadObj.service_tier = serviceTier;
      }
    });
  };
}

export function createOpenAITextVerbosityWrapper(
  baseStreamFn: StreamFn | undefined,
  verbosity: OpenAITextVerbosity,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.api !== "openai-responses" && model.api !== "openai-codex-responses") {
      return underlying(model, context, options);
    }
    const shouldOverrideExistingVerbosity = model.api === "openai-codex-responses";
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          const existingText =
            payloadObj.text && typeof payloadObj.text === "object"
              ? (payloadObj.text as Record<string, unknown>)
              : {};
          if (shouldOverrideExistingVerbosity || existingText.verbosity === undefined) {
            payloadObj.text = { ...existingText, verbosity };
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}
export function createCodexNativeWebSearchWrapper(
  baseStreamFn: StreamFn | undefined,
  params: { config?: OpenClawConfig; agentDir?: string },
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const activation = resolveCodexNativeSearchActivation({
      config: params.config,
      modelProvider: typeof model.provider === "string" ? model.provider : undefined,
      modelApi: typeof model.api === "string" ? model.api : undefined,
      agentDir: params.agentDir,
    });

    if (activation.state !== "native_active") {
      if (activation.codexNativeEnabled) {
        log.debug(
          `skipping Codex native web search (${activation.inactiveReason ?? "inactive"}) for ${String(
            model.provider ?? "unknown",
          )}/${String(model.id ?? "unknown")}`,
        );
      }
      return underlying(model, context, options);
    }

    log.debug(
      `activating Codex native web search (${activation.codexMode}) for ${String(
        model.provider ?? "unknown",
      )}/${String(model.id ?? "unknown")}`,
    );

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        const result = patchCodexNativeWebSearchPayload({
          payload,
          config: params.config,
        });
        if (result.status === "payload_not_object") {
          log.debug(
            "Skipping Codex native web search injection because provider payload is not an object",
          );
        } else if (result.status === "native_tool_already_present") {
          log.debug("Codex native web search tool already present in provider payload");
        } else if (result.status === "injected") {
          log.debug("Injected Codex native web search tool into provider payload");
        }
        return originalOnPayload?.(payload, model);
      },
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
      headers: resolveProviderRequestPolicyConfig({
        provider: attributionProvider,
        api: typeof model.api === "string" ? model.api : undefined,
        baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
        capability: "llm",
        transport: "stream",
        callerHeaders: options?.headers,
        precedence: "defaults-win",
      }).headers,
    });
  };
}
