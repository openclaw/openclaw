import { readStringValue } from "../shared/string-coerce.js";
import { supportsOpenAIReasoningEffort } from "./openai-reasoning-effort.js";
import { isOpenAIResponsesApi } from "./provider-attribution.js";
import { resolveProviderRequestPolicyConfig } from "./provider-request-config.js";
function parsePositiveInteger(value) {
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
function resolveOpenAIResponsesCompactThreshold(model) {
    const contextWindow = parsePositiveInteger(model.contextWindow);
    if (contextWindow) {
        return Math.max(1_000, Math.floor(contextWindow * 0.7));
    }
    return 80_000;
}
function readCompatBoolean(compat, key) {
    if (!compat || typeof compat !== "object") {
        return undefined;
    }
    const value = compat[key];
    return typeof value === "boolean" ? value : undefined;
}
function shouldEnableOpenAIResponsesServerCompaction(explicitStore, provider, extraParams) {
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
function stripDisabledOpenAIReasoningPayload(payloadObj) {
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
    const reasoningObj = reasoning;
    if (reasoningObj.effort === "none") {
        delete payloadObj.reasoning;
    }
}
export function resolveOpenAIResponsesPayloadPolicy(model, options = {}) {
    const compat = model.compat && typeof model.compat === "object"
        ? model.compat
        : undefined;
    const capabilities = resolveProviderRequestPolicyConfig({
        provider: readStringValue(model.provider),
        api: readStringValue(model.api),
        baseUrl: readStringValue(model.baseUrl),
        compat,
        capability: "llm",
        transport: "stream",
    }).capabilities;
    const storeMode = options.storeMode ?? "provider-policy";
    const explicitStore = storeMode === "preserve"
        ? undefined
        : storeMode === "disable"
            ? capabilities.supportsResponsesStoreField
                ? false
                : undefined
            : capabilities.allowsResponsesStore
                ? true
                : undefined;
    const isResponsesApi = isOpenAIResponsesApi(readStringValue(model.api));
    const shouldStripDisabledReasoningPayload = isResponsesApi &&
        (!capabilities.usesKnownNativeOpenAIRoute || !supportsOpenAIReasoningEffort(model, "none"));
    return {
        allowsServiceTier: capabilities.allowsOpenAIServiceTier,
        compactThreshold: parsePositiveInteger(options.extraParams?.responsesCompactThreshold) ??
            resolveOpenAIResponsesCompactThreshold(model),
        explicitStore,
        shouldStripDisabledReasoningPayload,
        shouldStripPromptCache: options.enablePromptCacheStripping === true && capabilities.shouldStripResponsesPromptCache,
        shouldStripStore: explicitStore !== true &&
            readCompatBoolean(model.compat, "supportsStore") === false &&
            isResponsesApi,
        useServerCompaction: options.enableServerCompaction === true &&
            shouldEnableOpenAIResponsesServerCompaction(explicitStore, model.provider, options.extraParams),
    };
}
export function applyOpenAIResponsesPayloadPolicy(payloadObj, policy) {
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
    if (policy.shouldStripDisabledReasoningPayload) {
        stripDisabledOpenAIReasoningPayload(payloadObj);
    }
}
