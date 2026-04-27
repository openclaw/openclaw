import type { Context } from "@mariozechner/pi-ai";
export declare const COPILOT_EDITOR_VERSION = "vscode/1.96.2";
export declare const COPILOT_USER_AGENT = "GitHubCopilotChat/0.26.7";
export declare const COPILOT_EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
export declare const COPILOT_GITHUB_API_VERSION = "2025-04-01";
export declare function hasCopilotVisionInput(messages: Context["messages"]): boolean;
export declare function buildCopilotIdeHeaders(params?: {
    includeApiVersion?: boolean;
}): Record<string, string>;
export declare function buildCopilotDynamicHeaders(params: {
    messages: Context["messages"];
    hasImages: boolean;
}): Record<string, string>;
