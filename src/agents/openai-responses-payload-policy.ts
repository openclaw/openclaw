import { readStringValue } from "../shared/string-coerce.js";
import { resolveProviderRequestPolicyConfig } from "./provider-request-config.js";

type OpenAIResponsesPayloadModel = {
  api?: unknown;
  baseUrl?: unknown;
  provider?: unknown;
  contextWindow?: unknown;
  compat?: { supportsStore?: boolean };
};

type OpenAIResponsesPayloadPolicyOptions = {
  extraParams?: Record<string, unknown>;
  storeMode?: "provider-policy" | "disable" | "preserve";
  enablePromptCacheStripping?: boolean;
  enableServerCompaction?: boolean;
};

export type OpenAIResponsesPayloadPolicy = {
  allowsServiceTier: boolean;
  compactThreshold: number;
  explicitStore: boolean | undefined;
  /**
   * How to handle disabled reasoning payloads that use legacy `reasoning: "none"` or
   * `reasoning.effort: "none"` values.
   */
  disabledReasoningEffortMode?: "strip" | "rewrite-minimal";
  shouldStripPromptCache: boolean;
  shouldStripStore: boolean;
  useServerCompaction: boolean;
};

const OPENAI_RESPONSES_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

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
  explicitStore: boolean | undefined,
  provider: unknown,
  extraParams: Record<string, unknown> | undefined,
): boolean {
  const configured = extraParams?.responsesServerCompaction;
  if (configured === false) {
    return false;
  }
  if (explicitStore !== true) {
    return false;
  }
  if (configured === true) {
    return true;
  }
  return provider === "openai";
}

function normalizeDisabledOpenAIReasoningPayload(
  payloadObj: Record<string, unknown>,
  mode: NonNullable<OpenAIResponsesPayloadPolicy["disabledReasoningEffortMode"]>,
): void {
  const reasoning = payloadObj.reasoning;

  const isDisabledReasoningString = reasoning === "none";
  const isDisabledReasoningObject =
    !!reasoning &&
    typeof reasoning === "object" &&
    !Array.isArray(reasoning) &&
    (reasoning as Record<string, unknown>).effort === "none";

  if (!isDisabledReasoningString && !isDisabledReasoningObject) {
    return;
  }

  if (mode === "rewrite-minimal") {
    const nextReasoning =
      reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)
        ? { ...(reasoning as Record<string, unknown>) }
        : {};
    nextReasoning.effort = "minimal";
    payloadObj.reasoning = nextReasoning;
    return;
  }

  // Default: strip.
  delete payloadObj.reasoning;
}

export function resolveOpenAIResponsesPayloadPolicy(
  model: OpenAIResponsesPayloadModel,
  options: OpenAIResponsesPayloadPolicyOptions = {},
): OpenAIResponsesPayloadPolicy {
  const capabilities = resolveProviderRequestPolicyConfig({
    provider: readStringValue(model.provider),
    api: readStringValue(model.api),
    baseUrl: readStringValue(model.baseUrl),
    compat: model.compat,
    capability: "llm",
    transport: "stream",
  }).capabilities;
  const storeMode = options.storeMode ?? "provider-policy";
  const explicitStore =
    storeMode === "preserve"
      ? undefined
      : storeMode === "disable"
        ? capabilities.supportsResponsesStoreField
          ? false
          : undefined
        : capabilities.allowsResponsesStore
          ? true
          : undefined;
  const isResponsesApi = typeof model.api === "string" && OPENAI_RESPONSES_APIS.has(model.api);

  return {
    allowsServiceTier: capabilities.allowsOpenAIServiceTier,
    compactThreshold:
      parsePositiveInteger(options.extraParams?.responsesCompactThreshold) ??
      resolveOpenAIResponsesCompactThreshold(model),
    explicitStore,
    disabledReasoningEffortMode: isResponsesApi
      ? capabilities.usesKnownNativeOpenAIRoute
        ? "rewrite-minimal"
        : "strip"
      : undefined,
    shouldStripPromptCache:
      options.enablePromptCacheStripping === true && capabilities.shouldStripResponsesPromptCache,
    shouldStripStore:
      explicitStore !== true && model.compat?.supportsStore === false && isResponsesApi,
    useServerCompaction:
      options.enableServerCompaction === true &&
      shouldEnableOpenAIResponsesServerCompaction(
        explicitStore,
        model.provider,
        options.extraParams,
      ),
  };
}

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
  if (policy.useServerCompaction && payloadObj.context_management === undefined) {
    payloadObj.context_management = [
      {
        type: "compaction",
        compact_threshold: policy.compactThreshold,
      },
    ];
  }
  if (policy.disabledReasoningEffortMode) {
    normalizeDisabledOpenAIReasoningPayload(payloadObj, policy.disabledReasoningEffortMode);
  }
}
