import { streamSimple } from "@mariozechner/pi-ai";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";
export { createMoonshotThinkingWrapper, resolveMoonshotThinkingKeep, resolveMoonshotThinkingType, } from "./moonshot-thinking-stream-wrappers.js";
export function shouldApplySiliconFlowThinkingOffCompat(params) {
    return (params.provider === "siliconflow" &&
        params.thinkingLevel === "off" &&
        params.modelId.startsWith("Pro/"));
}
export function createSiliconFlowThinkingWrapper(baseStreamFn) {
    const underlying = baseStreamFn ?? streamSimple;
    return (model, context, options) => streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
        if (payloadObj.thinking === "off") {
            payloadObj.thinking = null;
        }
    });
}
