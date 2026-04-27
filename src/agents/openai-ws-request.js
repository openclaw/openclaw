import { readStringValue } from "../shared/string-coerce.js";
import { mapOpenAIReasoningEffortForModel } from "./openai-reasoning-compat.js";
import { normalizeOpenAIReasoningEffort } from "./openai-reasoning-effort.js";
import { resolveOpenAITextVerbosity } from "./openai-text-verbosity.js";
import { resolveProviderRequestPolicyConfig } from "./provider-request-config.js";
import { stripSystemPromptCacheBoundary } from "./system-prompt-cache-boundary.js";
function stringifyStable(value) {
    if (value === undefined) {
        return "";
    }
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stringifyStable(entry)).join(",")}]`;
    }
    const entries = Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right));
    return `{${entries
        .map(([key, entry]) => `${JSON.stringify(key)}:${stringifyStable(entry)}`)
        .join(",")}}`;
}
function payloadWithoutIncrementalFields(payload) {
    const { input: _input, metadata: _metadata, previous_response_id: _previousResponseId, ...rest } = payload;
    return rest;
}
function payloadFieldsMatch(left, right) {
    return (stringifyStable(payloadWithoutIncrementalFields(left)) ===
        stringifyStable(payloadWithoutIncrementalFields(right)));
}
function inputItemsStartWith(input, baseline) {
    if (baseline.length > input.length) {
        return false;
    }
    return baseline.every((item, index) => stringifyStable(item) === stringifyStable(input[index]));
}
export function planOpenAIWebSocketRequestPayload(params) {
    const fullInputItems = Array.isArray(params.fullPayload.input) ? params.fullPayload.input : [];
    const previousInputItems = Array.isArray(params.previousRequestPayload?.input)
        ? params.previousRequestPayload.input
        : [];
    const previousResponseInputItems = params.previousResponseInputItems ?? [];
    if (params.previousResponseId &&
        params.previousRequestPayload &&
        payloadFieldsMatch(params.fullPayload, params.previousRequestPayload)) {
        const baseline = [...previousInputItems, ...previousResponseInputItems];
        if (inputItemsStartWith(fullInputItems, baseline)) {
            return {
                mode: "incremental",
                payload: {
                    ...params.fullPayload,
                    previous_response_id: params.previousResponseId,
                    input: fullInputItems.slice(baseline.length),
                },
            };
        }
    }
    const { previous_response_id: _previousResponseId, ...payload } = params.fullPayload;
    return { mode: "full_context", payload };
}
export function buildOpenAIWebSocketWarmUpPayload(params) {
    return {
        type: "response.create",
        generate: false,
        model: params.model,
        input: [],
        ...(params.tools?.length ? { tools: params.tools } : {}),
        ...(params.instructions ? { instructions: params.instructions } : {}),
        ...(params.metadata ? { metadata: params.metadata } : {}),
    };
}
export function buildOpenAIWebSocketResponseCreatePayload(params) {
    const extraParams = {};
    const streamOpts = params.options;
    if (streamOpts?.temperature !== undefined) {
        extraParams.temperature = streamOpts.temperature;
    }
    if (streamOpts?.maxTokens !== undefined) {
        extraParams.max_output_tokens = streamOpts.maxTokens;
    }
    if (streamOpts?.topP !== undefined) {
        extraParams.top_p = streamOpts.topP;
    }
    if (streamOpts?.toolChoice !== undefined) {
        extraParams.tool_choice = streamOpts.toolChoice;
    }
    const reasoningEffort = mapOpenAIReasoningEffortForModel({
        model: params.model,
        effort: streamOpts?.reasoningEffort ??
            streamOpts?.reasoning ??
            (params.model.reasoning ? "high" : undefined),
    });
    if (reasoningEffort || streamOpts?.reasoningSummary) {
        const reasoning = {};
        if (reasoningEffort !== undefined) {
            reasoning.effort = normalizeOpenAIReasoningEffort(reasoningEffort);
        }
        if (reasoningEffort !== "none" && streamOpts?.reasoningSummary !== undefined) {
            reasoning.summary = streamOpts.reasoningSummary;
        }
        extraParams.reasoning = reasoning;
    }
    const textVerbosity = resolveOpenAITextVerbosity(streamOpts);
    if (textVerbosity !== undefined) {
        const existingText = extraParams.text && typeof extraParams.text === "object"
            ? extraParams.text
            : {};
        extraParams.text = { ...existingText, verbosity: textVerbosity };
    }
    const supportsResponsesStoreField = resolveProviderRequestPolicyConfig({
        provider: readStringValue(params.model.provider),
        api: readStringValue(params.model.api),
        baseUrl: readStringValue(params.model.baseUrl),
        compat: params.model.compat,
        capability: "llm",
        transport: "websocket",
    }).capabilities.supportsResponsesStoreField;
    return {
        type: "response.create",
        model: params.model.id,
        ...(supportsResponsesStoreField ? { store: false } : {}),
        input: params.turnInput.inputItems,
        instructions: params.context.systemPrompt
            ? stripSystemPromptCacheBoundary(params.context.systemPrompt)
            : undefined,
        tools: params.tools.length > 0 ? params.tools : undefined,
        ...(params.turnInput.previousResponseId
            ? { previous_response_id: params.turnInput.previousResponseId }
            : {}),
        ...(params.metadata ? { metadata: params.metadata } : {}),
        ...extraParams,
    };
}
