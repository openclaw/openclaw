import { streamSimple } from "@mariozechner/pi-ai";
const MINIMAX_FAST_MODEL_IDS = new Map([
    ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
]);
function resolveMinimaxFastModelId(modelId) {
    if (typeof modelId !== "string") {
        return undefined;
    }
    return MINIMAX_FAST_MODEL_IDS.get(modelId.trim());
}
function isMinimaxAnthropicMessagesModel(model) {
    return (model.api === "anthropic-messages" &&
        (model.provider === "minimax" || model.provider === "minimax-portal"));
}
export function createMinimaxFastModeWrapper(baseStreamFn, fastMode) {
    const underlying = baseStreamFn ?? streamSimple;
    return (model, context, options) => {
        if (!fastMode ||
            model.api !== "anthropic-messages" ||
            (model.provider !== "minimax" && model.provider !== "minimax-portal")) {
            return underlying(model, context, options);
        }
        const fastModelId = resolveMinimaxFastModelId(model.id);
        if (!fastModelId) {
            return underlying(model, context, options);
        }
        return underlying({ ...model, id: fastModelId }, context, options);
    };
}
/**
 * MiniMax's Anthropic-compatible streaming endpoint returns reasoning_content
 * in OpenAI-style delta chunks ({delta: {content: "", reasoning_content: "..."}})
 * rather than the native Anthropic thinking block format. Pi-ai's Anthropic
 * provider cannot process this format and leaks the reasoning text as visible
 * content. Disable thinking in the outgoing payload so MiniMax does not produce
 * reasoning_content deltas during streaming.
 */
export function createMinimaxThinkingDisabledWrapper(baseStreamFn) {
    const underlying = baseStreamFn ?? streamSimple;
    return (model, context, options) => {
        if (!isMinimaxAnthropicMessagesModel(model)) {
            return underlying(model, context, options);
        }
        const originalOnPayload = options?.onPayload;
        return underlying(model, context, {
            ...options,
            onPayload: (payload) => {
                if (payload && typeof payload === "object") {
                    const payloadObj = payload;
                    // Only inject if thinking is not already explicitly set.
                    // This preserves any intentional override from other wrappers.
                    if (payloadObj.thinking === undefined) {
                        payloadObj.thinking = { type: "disabled" };
                    }
                }
                return originalOnPayload?.(payload, model);
            },
        });
    };
}
