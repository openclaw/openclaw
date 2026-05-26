import type { Context } from "@earendil-works/pi-ai";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export declare const COPILOT_EDITOR_VERSION = "vscode/1.107.0";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export declare const COPILOT_USER_AGENT = "GitHubCopilotChat/0.35.0";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export declare const COPILOT_EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export declare const COPILOT_GITHUB_API_VERSION = "2025-04-01";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export declare const COPILOT_INTEGRATION_ID = "vscode-chat";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
export declare function buildCopilotIdeHeaders(params?: {
    includeApiVersion?: boolean;
}): Record<string, string>;
export declare function hasCopilotVisionInput(messages: Context["messages"]): boolean;
export declare function buildCopilotDynamicHeaders(params: {
    messages: Context["messages"];
    hasImages: boolean;
}): Record<string, string>;
