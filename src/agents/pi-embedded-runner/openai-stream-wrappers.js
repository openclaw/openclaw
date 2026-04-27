import { streamSimple } from "@mariozechner/pi-ai";
import { normalizeOptionalLowercaseString, readStringValue } from "../../shared/string-coerce.js";
import { patchCodexNativeWebSearchPayload, resolveCodexNativeSearchActivation, } from "../codex-native-web-search.js";
import { flattenCompletionMessagesToStringContent } from "../openai-completions-string-content.js";
import { applyOpenAIResponsesPayloadPolicy, resolveOpenAIResponsesPayloadPolicy, } from "../openai-responses-payload-policy.js";
import { resolveOpenAITextVerbosity } from "../openai-text-verbosity.js";
import { resolveProviderRequestPolicyConfig } from "../provider-request-config.js";
import { log } from "./logger.js";
import { mapThinkingLevelToReasoningEffort } from "./reasoning-effort-utils.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";
export { resolveOpenAITextVerbosity };
function resolveOpenAIRequestCapabilities(model) {
    const compat = model.compat && typeof model.compat === "object"
        ? model.compat
        : undefined;
    return resolveProviderRequestPolicyConfig({
        provider: readStringValue(model.provider),
        api: readStringValue(model.api),
        baseUrl: readStringValue(model.baseUrl),
        compat,
        capability: "llm",
        transport: "stream",
    }).capabilities;
}
function shouldApplyOpenAIAttributionHeaders(model) {
    const attributionProvider = resolveOpenAIRequestCapabilities(model).attributionProvider;
    return attributionProvider === "openai" || attributionProvider === "openai-codex"
        ? attributionProvider
        : undefined;
}
function shouldApplyOpenAIServiceTier(model) {
    return resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "disable" }).allowsServiceTier;
}
function shouldApplyOpenAIReasoningCompatibility(model) {
    const api = readStringValue(model.api);
    const provider = readStringValue(model.provider);
    if (!api || !provider) {
        return false;
    }
    return resolveOpenAIRequestCapabilities(model).supportsOpenAIReasoningCompatPayload;
}
function shouldFlattenOpenAICompletionMessages(model) {
    const compat = model.compat && typeof model.compat === "object"
        ? model.compat
        : undefined;
    return model.api === "openai-completions" && compat?.requiresStringContent === true;
}
function normalizeOpenAIServiceTier(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = normalizeOptionalLowercaseString(value);
    if (normalized === "auto" ||
        normalized === "default" ||
        normalized === "flex" ||
        normalized === "priority") {
        return normalized;
    }
    return undefined;
}
export function resolveOpenAIServiceTier(extraParams) {
    const raw = extraParams?.serviceTier ?? extraParams?.service_tier;
    const normalized = normalizeOpenAIServiceTier(raw);
    if (raw !== undefined && normalized === undefined) {
        const rawSummary = typeof raw === "string" ? raw : typeof raw;
        log.warn(`ignoring invalid OpenAI service tier param: ${rawSummary}`);
    }
    return normalized;
}
function normalizeOpenAIFastMode(value) {
    if (typeof value === "boolean") {
        return value;
    }
    const normalized = normalizeOptionalLowercaseString(value);
    if (!normalized) {
        return undefined;
    }
    if (normalized === "on" ||
        normalized === "true" ||
        normalized === "yes" ||
        normalized === "1" ||
        normalized === "fast") {
        return true;
    }
    if (normalized === "off" ||
        normalized === "false" ||
        normalized === "no" ||
        normalized === "0" ||
        normalized === "normal") {
        return false;
    }
    return undefined;
}
export function resolveOpenAIFastMode(extraParams) {
    const raw = extraParams?.fastMode ?? extraParams?.fast_mode;
    const normalized = normalizeOpenAIFastMode(raw);
    if (raw !== undefined && normalized === undefined) {
        const rawSummary = typeof raw === "string" ? raw : typeof raw;
        log.warn(`ignoring invalid OpenAI fast mode param: ${rawSummary}`);
    }
    return normalized;
}
function applyOpenAIFastModePayloadOverrides(params) {
    if (params.payloadObj.service_tier === undefined && shouldApplyOpenAIServiceTier(params.model)) {
        params.payloadObj.service_tier = "priority";
    }
}
export function createOpenAIResponsesContextManagementWrapper(baseStreamFn, extraParams) {
    const underlying = baseStreamFn ?? streamSimple;
    return (model, context, options) => {
        const policy = resolveOpenAIResponsesPayloadPolicy(model, {
            extraParams,
            enablePromptCacheStripping: true,
            enableServerCompaction: true,
            storeMode: "provider-policy",
        });
        if (policy.explicitStore === undefined &&
            !policy.useServerCompaction &&
            !policy.shouldStripStore &&
            !policy.shouldStripPromptCache &&
            !policy.shouldStripDisabledReasoningPayload) {
            return underlying(model, context, options);
        }
        const originalOnPayload = options?.onPayload;
        return underlying(model, context, {
            ...options,
            onPayload: (payload) => {
                if (payload && typeof payload === "object") {
                    applyOpenAIResponsesPayloadPolicy(payload, policy);
                }
                return originalOnPayload?.(payload, model);
            },
        });
    };
}
export function createOpenAIReasoningCompatibilityWrapper(baseStreamFn) {
    const underlying = baseStreamFn ?? streamSimple;
    return (model, context, options) => {
        if (!shouldApplyOpenAIReasoningCompatibility(model)) {
            return underlying(model, context, options);
        }
        return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
            applyOpenAIResponsesPayloadPolicy(payloadObj, resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "preserve" }));
        });
    };
}
export function createOpenAIStringContentWrapper(baseStreamFn) {
    const underlying = baseStreamFn ?? streamSimple;
    return (model, context, options) => {
        if (!shouldFlattenOpenAICompletionMessages(model)) {
            return underlying(model, context, options);
        }
        return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
            if (!Array.isArray(payloadObj.messages)) {
                return;
            }
            payloadObj.messages = flattenCompletionMessagesToStringContent(payloadObj.messages);
        });
    };
}
export function createOpenAIThinkingLevelWrapper(baseStreamFn, thinkingLevel) {
    const underlying = baseStreamFn ?? streamSimple;
    if (!thinkingLevel) {
        return underlying;
    }
    return (model, context, options) => {
        if (!shouldApplyOpenAIReasoningCompatibility(model)) {
            return underlying(model, context, options);
        }
        return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
            const existingReasoning = payloadObj.reasoning;
            if (thinkingLevel === "off") {
                if (existingReasoning !== undefined) {
                    delete payloadObj.reasoning;
                }
                return;
            }
            if (existingReasoning === "none") {
                payloadObj.reasoning = { effort: mapThinkingLevelToReasoningEffort(thinkingLevel) };
                return;
            }
            if (existingReasoning &&
                typeof existingReasoning === "object" &&
                !Array.isArray(existingReasoning)) {
                existingReasoning.effort =
                    mapThinkingLevelToReasoningEffort(thinkingLevel);
            }
        });
    };
}
export function createOpenAIFastModeWrapper(baseStreamFn) {
    const underlying = baseStreamFn ?? streamSimple;
    return (model, context, options) => {
        if ((model.api !== "openai-responses" &&
            model.api !== "openai-codex-responses" &&
            model.api !== "azure-openai-responses") ||
            (model.provider !== "openai" && model.provider !== "openai-codex")) {
            return underlying(model, context, options);
        }
        const originalOnPayload = options?.onPayload;
        return underlying(model, context, {
            ...options,
            onPayload: (payload) => {
                if (payload && typeof payload === "object") {
                    applyOpenAIFastModePayloadOverrides({
                        payloadObj: payload,
                        model,
                    });
                }
                return originalOnPayload?.(payload, model);
            },
        });
    };
}
export function createOpenAIServiceTierWrapper(baseStreamFn, serviceTier) {
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
export function createOpenAITextVerbosityWrapper(baseStreamFn, verbosity) {
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
                    const payloadObj = payload;
                    const existingText = payloadObj.text && typeof payloadObj.text === "object"
                        ? payloadObj.text
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
export function createCodexNativeWebSearchWrapper(baseStreamFn, params) {
    const underlying = baseStreamFn ?? streamSimple;
    return (model, context, options) => {
        const activation = resolveCodexNativeSearchActivation({
            config: params.config,
            modelProvider: readStringValue(model.provider),
            modelApi: readStringValue(model.api),
            agentDir: params.agentDir,
        });
        if (activation.state !== "native_active") {
            if (activation.codexNativeEnabled) {
                log.debug(`skipping Codex native web search (${activation.inactiveReason ?? "inactive"}) for ${model.provider ?? "unknown"}/${model.id ?? "unknown"}`);
            }
            return underlying(model, context, options);
        }
        log.debug(`activating Codex native web search (${activation.codexMode}) for ${model.provider ?? "unknown"}/${model.id ?? "unknown"}`);
        const originalOnPayload = options?.onPayload;
        return underlying(model, context, {
            ...options,
            onPayload: (payload) => {
                const result = patchCodexNativeWebSearchPayload({
                    payload,
                    config: params.config,
                });
                if (result.status === "payload_not_object") {
                    log.debug("Skipping Codex native web search injection because provider payload is not an object");
                }
                else if (result.status === "native_tool_already_present") {
                    log.debug("Codex native web search tool already present in provider payload");
                }
                else if (result.status === "injected") {
                    log.debug("Injected Codex native web search tool into provider payload");
                }
                return originalOnPayload?.(payload, model);
            },
        });
    };
}
export function createCodexDefaultTransportWrapper(baseStreamFn) {
    const underlying = baseStreamFn ?? streamSimple;
    return (model, context, options) => underlying(model, context, {
        ...options,
        transport: options?.transport ?? "auto",
    });
}
export function createOpenAIDefaultTransportWrapper(baseStreamFn) {
    const underlying = baseStreamFn ?? streamSimple;
    return (model, context, options) => {
        const typedOptions = options;
        const mergedOptions = {
            ...options,
            transport: options?.transport ?? "auto",
            openaiWsWarmup: typedOptions?.openaiWsWarmup ?? true,
        };
        return underlying(model, context, mergedOptions);
    };
}
export function createOpenAIAttributionHeadersWrapper(baseStreamFn) {
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
                api: readStringValue(model.api),
                baseUrl: readStringValue(model.baseUrl),
                capability: "llm",
                transport: "stream",
                callerHeaders: options?.headers,
                precedence: "defaults-win",
            }).headers,
        });
    };
}
