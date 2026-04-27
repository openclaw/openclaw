import { streamSimple } from "@mariozechner/pi-ai";
import { isAnthropicBedrockModel } from "./anthropic-family-cache-semantics.js";
export function createBedrockNoCacheWrapper(baseStreamFn) {
    const underlying = baseStreamFn ?? streamSimple;
    return (model, context, options) => underlying(model, context, {
        ...options,
        cacheRetention: "none",
    });
}
export { isAnthropicBedrockModel };
