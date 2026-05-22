import type { Context } from "@mariozechner/pi-ai";
export { buildCopilotIdeHeaders } from "../plugin-sdk/provider-auth.js";
export declare function hasCopilotVisionInput(messages: Context["messages"]): boolean;
export declare function buildCopilotDynamicHeaders(params: {
    messages: Context["messages"];
    hasImages: boolean;
}): Record<string, string>;
