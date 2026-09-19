import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
/**
 * OpenAI Responses payload policy.
 * Classifies endpoint capabilities and applies store, prompt-cache,
 * server-compaction, service-tier, and reasoning payload rules.
 */
import {
  normalizeOptionalLowercaseString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { supportsOpenAIReasoningEffort } from "../providers/openai-reasoning-effort.js";
import { OPENAI_RESPONSES_APIS } from "./openai-responses-contracts.js";
import { parsePositiveInteger } from "./positive-integer.js";

type OpenAIResponsesPayloadModel = {
  api?: unknown;
  baseUrl?: unknown;
  id?: unknown;
  provider?: unknown;
  contextTokens?: unknown;
  contextWindow?: unknown;
  compat?: unknown;
};

type OpenAIResponsesPayloadPolicyOptions = {
  extraParams?: Record<string, unknown>;
  storeMode?: "provider-policy" | "transport-default" | "disable" | "preserve";
  enablePromptCacheStripping?: boolean;
  enableServerCompaction?: boolean;
};

type OpenAIResponsesEndpointClass =
  | "default"
  | "openai-public"
  | "openai"
  | "azure-openai"
  | "xai-native"
  | "custom";

type OpenAIResponsesPayloadPolicy = {
  allowsSafetyIdentifier: boolean;
  allowsServiceTier: boolean;
  compactThreshold: number | undefined;
  defaultManagedReasoningEffort: "none" | undefined;
  explicitContinuationOptIn: boolean;
  explicitStore: boolean | undefined;
  shouldStripDisabledReasoningPayload: boolean;
  shouldStripInputStatus: boolean;
  shouldStripPromptCache: boolean;
  shouldStripStore: boolean;
  useServerCompaction: boolean;
  usesInstructionsField: boolean;
};

type OpenAIResponsesPayloadCapabilities = {
  allowsOpenAISafetyIdentifier: boolean;
  allowsOpenAIServiceTier: boolean;
  allowsResponsesStore: boolean;
  explicitContinuationOptIn: boolean;
  shouldStripResponsesPromptCache: boolean;
  supportsResponsesStoreField: boolean;
  usesKnownNativeOpenAIRoute: boolean;
  usesVerifiedInstructionsEndpoint: boolean;
};

const OPENAI_RESPONSES_PROVIDERS = new Set(["openai", "azure-openai", "azure-openai-responses"]);
function resolveUrlHostname(value: unknown): string | undefined {
  const trimmed = readStringValue(value)?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`https://${trimmed}`).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }
}

function resolveOpenAIResponsesEndpointClass(baseUrl: unknown): OpenAIResponsesEndpointClass {
  const trimmed = readStringValue(baseUrl)?.trim();
  if (!trimmed) {
    return "default";
  }
  const host = resolveUrlHostname(trimmed);
  if (!host) {
    return "custom";
  }
  switch (host) {
    case "api.openai.com":
      return "openai-public";
    case "chatgpt.com":
      return "openai";
    case "api.x.ai":
      return "xai-native";
  }
  if (
    [
      ".openai.azure.com",
      ".cognitiveservices.azure.com",
      ".services.ai.azure.com",
      ".api.cognitive.microsoft.com",
    ].some((suffix) => host.endsWith(suffix))
  ) {
    return "azure-openai";
  }
  return "custom";
}

function isOpenAIResponsesApi(api: string | undefined): boolean {
  return api !== undefined && OPENAI_RESPONSES_APIS.has(api);
}

function readCompatPayloadBoolean(
  compat: unknown,
  key:
    | "supportsInstructions"
    | "supportsPromptCacheKey"
    | "supportsResponsesContinuation"
    | "supportsStore",
): boolean | undefined {
  if (!compat || typeof compat !== "object") {
    return undefined;
  }
  const value = (compat as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function resolveOpenAIResponsesPayloadCapabilities(
  model: OpenAIResponsesPayloadModel,
): OpenAIResponsesPayloadCapabilities {
  const provider = normalizeOptionalLowercaseString(model.provider);
  const api = normalizeOptionalLowercaseString(model.api);
  const isOpenAIProvider = provider === "openai";
  const endpointClass = resolveOpenAIResponsesEndpointClass(model.baseUrl);
  const isResponsesApi = isOpenAIResponsesApi(api);
  const usesConfiguredBaseUrl = endpointClass !== "default";
  const usesKnownNativeOpenAIEndpoint =
    endpointClass === "openai-public" ||
    endpointClass === "openai" ||
    endpointClass === "azure-openai";
  const usesKnownNativeOpenAIRoute =
    endpointClass === "default" ? provider === "openai" : usesKnownNativeOpenAIEndpoint;
  const usesExplicitProxyLikeEndpoint = usesConfiguredBaseUrl && !usesKnownNativeOpenAIEndpoint;
  // Only native OpenAI and xAI's main route have verified instructions support.
  // Azure remains distinct from native OpenAI for this capability; other routes
  // require compat.supportsInstructions to opt in after contract verification.
  const usesVerifiedNativeOpenAIRoute =
    endpointClass === "default"
      ? provider === "openai"
      : endpointClass === "openai-public" || endpointClass === "openai";
  const usesVerifiedInstructionsEndpoint =
    usesVerifiedNativeOpenAIRoute || endpointClass === "xai-native";
  const promptCacheKeySupport = readCompatPayloadBoolean(model.compat, "supportsPromptCacheKey");
  const shouldStripResponsesPromptCache =
    promptCacheKeySupport === true
      ? false
      : promptCacheKeySupport === false
        ? isResponsesApi
        : isResponsesApi && usesExplicitProxyLikeEndpoint;
  const supportsResponsesStoreField =
    readCompatPayloadBoolean(model.compat, "supportsStore") !== false && isResponsesApi;
  // Explicit model capability enables stored HTTP continuation on compatible routes.
  // Azure and ChatGPT transport contracts stay excluded by API/provider identity.
  const explicitContinuationOptIn =
    (api === "openai-responses" || api === "openclaw-openai-responses-transport") &&
    supportsResponsesStoreField &&
    provider !== "azure-openai" &&
    provider !== "azure-openai-responses" &&
    readCompatPayloadBoolean(model.compat, "supportsResponsesContinuation") === true;

  return {
    // `safety_identifier` is an OpenAI Platform abuse-monitoring field accepted by
    // both Responses and Chat Completions on api.openai.com. The ChatGPT/Codex
    // backend, Azure OpenAI, and OpenAI-compatible proxies are not verified to
    // accept it, so only the public Platform host gets it.
    allowsOpenAISafetyIdentifier:
      isOpenAIProvider &&
      (api === "openai-responses" ||
        api === "openclaw-openai-responses-transport" ||
        api === "openai-completions") &&
      endpointClass === "openai-public",
    allowsOpenAIServiceTier:
      (provider === "openai" &&
        (api === "openai-responses" || api === "openclaw-openai-responses-transport") &&
        endpointClass === "openai-public") ||
      (isOpenAIProvider &&
        (api === "openai-chatgpt-responses" ||
          api === "openclaw-openai-chatgpt-responses-transport" ||
          api === "openai-responses" ||
          api === "openclaw-openai-responses-transport") &&
        endpointClass === "openai"),
    allowsResponsesStore:
      supportsResponsesStoreField &&
      api !== "openai-chatgpt-responses" &&
      api !== "openclaw-openai-chatgpt-responses-transport" &&
      provider !== undefined &&
      OPENAI_RESPONSES_PROVIDERS.has(provider) &&
      usesKnownNativeOpenAIEndpoint,
    explicitContinuationOptIn,
    shouldStripResponsesPromptCache,
    supportsResponsesStoreField,
    usesKnownNativeOpenAIRoute,
    usesVerifiedInstructionsEndpoint,
  };
}

function resolveOpenAIResponsesCompactThreshold(model: {
  contextTokens?: unknown;
  contextWindow?: unknown;
}): number {
  const contextTokens = parsePositiveInteger(model.contextTokens);
  const contextWindow = parsePositiveInteger(model.contextWindow);
  const effectiveBudget =
    contextTokens && contextWindow
      ? Math.min(contextTokens, contextWindow)
      : contextTokens || contextWindow;
  if (effectiveBudget) {
    return Math.max(1_000, Math.floor(effectiveBudget * 0.7));
  }
  return 80_000;
}

/** Resolve the server-compaction gate and effective threshold for a Responses route. */
export function resolveOpenAIResponsesServerCompactionPlan(
  model: OpenAIResponsesPayloadModel,
  extraParams?: Record<string, unknown>,
): { enabled: boolean; threshold: number | undefined } {
  const provider = normalizeOptionalLowercaseString(model.provider);
  const allowsResponsesStore =
    resolveOpenAIResponsesPayloadCapabilities(model).allowsResponsesStore;
  const configured = extraParams?.responsesServerCompaction;
  const enabled =
    configured !== false && allowsResponsesStore && (configured === true || provider === "openai");
  return {
    enabled,
    threshold: enabled
      ? (parsePositiveInteger(extraParams?.responsesCompactThreshold) ??
        resolveOpenAIResponsesCompactThreshold(model))
      : undefined,
  };
}

/** Resolve the Responses compact-endpoint gate for one route and compaction purpose. */
export function resolveOpenAIResponsesCompactEndpointPlan(
  model: OpenAIResponsesPayloadModel,
  extraParams?: Record<string, unknown>,
  purpose: "manual" | "budget" = "manual",
): { enabled: boolean } {
  const configured = extraParams?.responsesCompactEndpoint;
  const provider = typeof model.provider === "string" ? normalizeProviderId(model.provider) : "";
  const api = normalizeOptionalLowercaseString(model.api);
  const endpointClass = resolveOpenAIResponsesEndpointClass(model.baseUrl);
  const enabledByDefault =
    ((provider === "xai" || provider === "x-ai") && endpointClass === "xai-native") ||
    (purpose === "budget" &&
      provider === "openai" &&
      api === "openai-responses" &&
      endpointClass === "openai-public");
  return {
    enabled:
      isOpenAIResponsesApi(api) &&
      configured !== false &&
      (configured === true || enabledByDefault),
  };
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

  // Some Responses models and OpenAI-compatible proxies reject
  // `reasoning.effort: "none"`. Treat unsupported disabled effort as omitted.
  const reasoningObj = reasoning as Record<string, unknown>;
  if (reasoningObj.effort === "none") {
    delete payloadObj.reasoning;
  }
}

/** Strip returned-item metadata rejected by strict Responses-compatible endpoints. */
function stripInputItemStatuses(input: unknown): void {
  if (!Array.isArray(input)) {
    return;
  }
  for (const item of input) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      // Only item-level status is provider metadata. Nested values may be user or tool payloads.
      delete (item as Record<string, unknown>).status;
    }
  }
}

/** Resolve payload mutation policy for one OpenAI Responses-style model endpoint. */
export function resolveOpenAIResponsesPayloadPolicy(
  model: OpenAIResponsesPayloadModel,
  options: OpenAIResponsesPayloadPolicyOptions = {},
): OpenAIResponsesPayloadPolicy {
  const capabilities = resolveOpenAIResponsesPayloadCapabilities(model);
  const storeMode = options.storeMode ?? "provider-policy";
  // Public policy callers retain a strict no-store choice through disable.
  // Transport defaults stay stateless unless the model explicitly opts in.
  // Native provider wrappers enable storage separately through provider-policy.
  const explicitStore =
    storeMode === "preserve"
      ? undefined
      : storeMode === "disable" ||
          (storeMode === "transport-default" && !capabilities.explicitContinuationOptIn)
        ? capabilities.supportsResponsesStoreField
          ? false
          : undefined
        : capabilities.allowsResponsesStore || capabilities.explicitContinuationOptIn
          ? true
          : undefined;
  const isResponsesApi = isOpenAIResponsesApi(normalizeOptionalLowercaseString(model.api));
  const shouldStripDisabledReasoningPayload =
    isResponsesApi &&
    // Custom endpoints need an explicit capability; model-name hints describe native routes.
    !supportsOpenAIReasoningEffort(
      capabilities.usesKnownNativeOpenAIRoute ? model : { compat: model.compat },
      "none",
    );
  // Strict OpenAI-compatible Responses endpoints reject output-only fields
  // such as `status` on replayed input items. Strip them for non-native routes.
  const shouldStripInputStatus = isResponsesApi && !capabilities.usesKnownNativeOpenAIRoute;
  const serverCompactionPlan = resolveOpenAIResponsesServerCompactionPlan(
    model,
    options.extraParams,
  );
  // Verified native OpenAI/xAI routes default instructions on; compat overrides.
  // Other endpoints could silently drop this field and the system prompt.
  // Stored-continuation support does not prove instructions support.
  const instructionsCompat = readCompatPayloadBoolean(model.compat, "supportsInstructions");
  const usesInstructionsField = instructionsCompat ?? capabilities.usesVerifiedInstructionsEndpoint;

  return {
    allowsSafetyIdentifier: capabilities.allowsOpenAISafetyIdentifier,
    allowsServiceTier: capabilities.allowsOpenAIServiceTier,
    compactThreshold: serverCompactionPlan.threshold,
    // Managed proxies inherit their provider default; explicit none is a separate capability.
    defaultManagedReasoningEffort:
      capabilities.usesKnownNativeOpenAIRoute &&
      !shouldStripDisabledReasoningPayload &&
      model.provider !== "github-copilot"
        ? "none"
        : undefined,
    explicitContinuationOptIn: capabilities.explicitContinuationOptIn,
    explicitStore,
    shouldStripDisabledReasoningPayload,
    shouldStripInputStatus,
    shouldStripPromptCache:
      options.enablePromptCacheStripping === true && capabilities.shouldStripResponsesPromptCache,
    shouldStripStore:
      explicitStore !== true &&
      readCompatPayloadBoolean(model.compat, "supportsStore") === false &&
      isResponsesApi,
    useServerCompaction: options.enableServerCompaction === true && serverCompactionPlan.enabled,
    usesInstructionsField,
  };
}

/** Mutate a Responses request payload according to the resolved endpoint policy. */
export function applyOpenAIResponsesPayloadPolicy(
  payloadObj: Record<string, unknown>,
  policy: OpenAIResponsesPayloadPolicy,
): void {
  if (policy.explicitStore !== undefined) {
    payloadObj.store = policy.explicitStore;
  }
  if (policy.shouldStripStore) {
    delete payloadObj.store;
  }
  if (policy.shouldStripPromptCache) {
    delete payloadObj.prompt_cache_key;
    delete payloadObj.prompt_cache_retention;
  }
  if (
    policy.useServerCompaction &&
    policy.compactThreshold !== undefined &&
    payloadObj.context_management === undefined
  ) {
    payloadObj.context_management = [
      {
        type: "compaction",
        compact_threshold: policy.compactThreshold,
      },
    ];
  }
  if (policy.shouldStripDisabledReasoningPayload) {
    stripDisabledOpenAIReasoningPayload(payloadObj);
  }
  if (policy.shouldStripInputStatus) {
    stripInputItemStatuses(payloadObj.input);
  }
}
