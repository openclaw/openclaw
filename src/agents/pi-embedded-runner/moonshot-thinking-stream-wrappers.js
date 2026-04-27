import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";
const MOONSHOT_THINKING_KEEP_MODEL_ID = "kimi-k2.6";
let piAiRuntimePromise;
async function loadDefaultStreamFn() {
    piAiRuntimePromise ??= import("@mariozechner/pi-ai");
    const runtime = await piAiRuntimePromise;
    return runtime.streamSimple;
}
function normalizeMoonshotThinkingType(value) {
    if (typeof value === "boolean") {
        return value ? "enabled" : "disabled";
    }
    if (typeof value === "string") {
        const normalized = normalizeOptionalLowercaseString(value);
        if (!normalized) {
            return undefined;
        }
        if (["enabled", "enable", "on", "true"].includes(normalized)) {
            return "enabled";
        }
        if (["disabled", "disable", "off", "false"].includes(normalized)) {
            return "disabled";
        }
        return undefined;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return normalizeMoonshotThinkingType(value.type);
    }
    return undefined;
}
function normalizeMoonshotThinkingKeep(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const keepValue = value.keep;
    if (typeof keepValue !== "string") {
        return undefined;
    }
    return normalizeOptionalLowercaseString(keepValue) === "all" ? "all" : undefined;
}
function isMoonshotToolChoiceCompatible(toolChoice) {
    if (toolChoice == null || toolChoice === "auto" || toolChoice === "none") {
        return true;
    }
    if (typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
        const typeValue = toolChoice.type;
        return typeValue === "auto" || typeValue === "none";
    }
    return false;
}
function isPinnedToolChoice(toolChoice) {
    if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
        return false;
    }
    const typeValue = toolChoice.type;
    return typeValue === "tool" || typeValue === "function";
}
export function resolveMoonshotThinkingType(params) {
    const configured = normalizeMoonshotThinkingType(params.configuredThinking);
    if (configured) {
        return configured;
    }
    if (!params.thinkingLevel) {
        return undefined;
    }
    return params.thinkingLevel === "off" ? "disabled" : "enabled";
}
export function resolveMoonshotThinkingKeep(params) {
    return normalizeMoonshotThinkingKeep(params.configuredThinking);
}
export function createMoonshotThinkingWrapper(baseStreamFn, thinkingType, thinkingKeep) {
    return async (model, context, options) => {
        const underlying = baseStreamFn ?? (await loadDefaultStreamFn());
        return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
            let effectiveThinkingType = normalizeMoonshotThinkingType(payloadObj.thinking);
            if (thinkingType) {
                payloadObj.thinking = { type: thinkingType };
                effectiveThinkingType = thinkingType;
            }
            if (effectiveThinkingType === "enabled" &&
                !isMoonshotToolChoiceCompatible(payloadObj.tool_choice)) {
                if (payloadObj.tool_choice === "required") {
                    payloadObj.tool_choice = "auto";
                }
                else if (isPinnedToolChoice(payloadObj.tool_choice)) {
                    payloadObj.thinking = { type: "disabled" };
                    effectiveThinkingType = "disabled";
                }
            }
            // thinking.keep is only valid on kimi-k2.6 when thinking is enabled. Gate
            // by the final payload.model and final type so stray config never leaks.
            const isKeepCapableModel = payloadObj.model === MOONSHOT_THINKING_KEEP_MODEL_ID;
            if (payloadObj.thinking && typeof payloadObj.thinking === "object") {
                const thinkingObj = payloadObj.thinking;
                if (isKeepCapableModel && effectiveThinkingType === "enabled" && thinkingKeep === "all") {
                    thinkingObj.keep = "all";
                }
                else if ("keep" in thinkingObj) {
                    delete thinkingObj.keep;
                }
            }
        });
    };
}
