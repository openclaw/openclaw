import type { Context } from "@earendil-works/pi-ai";
export { COPILOT_INTEGRATION_ID, buildCopilotIdeHeaders } from "../plugin-sdk/provider-auth.js";
export declare function hasCopilotVisionInput(messages: Context["messages"]): boolean;
export declare function buildCopilotDynamicHeaders(params: {
    messages: Context["messages"];
    hasImages: boolean;
}): Record<string, string>;
