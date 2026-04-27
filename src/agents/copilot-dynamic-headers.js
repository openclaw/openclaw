export const COPILOT_EDITOR_VERSION = "vscode/1.96.2";
export const COPILOT_USER_AGENT = "GitHubCopilotChat/0.26.7";
export const COPILOT_EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
export const COPILOT_GITHUB_API_VERSION = "2025-04-01";
function inferCopilotInitiator(messages) {
    const last = messages[messages.length - 1];
    if (!last) {
        return "user";
    }
    if (last.role === "user" && containsCopilotContentType(last.content, "tool_result")) {
        return "agent";
    }
    return last.role === "user" ? "user" : "agent";
}
function containsCopilotContentType(value, type) {
    if (Array.isArray(value)) {
        return value.some((item) => containsCopilotContentType(item, type));
    }
    if (!value || typeof value !== "object") {
        return false;
    }
    const entry = value;
    return entry.type === type || containsCopilotContentType(entry.content, type);
}
export function hasCopilotVisionInput(messages) {
    return messages.some((message) => {
        if (message.role === "user" && Array.isArray(message.content)) {
            return message.content.some((item) => containsCopilotContentType(item, "image"));
        }
        if (message.role === "toolResult" && Array.isArray(message.content)) {
            return message.content.some((item) => containsCopilotContentType(item, "image"));
        }
        return false;
    });
}
export function buildCopilotIdeHeaders(params = {}) {
    return {
        "Editor-Version": COPILOT_EDITOR_VERSION,
        "Editor-Plugin-Version": COPILOT_EDITOR_PLUGIN_VERSION,
        "User-Agent": COPILOT_USER_AGENT,
        ...(params.includeApiVersion ? { "X-Github-Api-Version": COPILOT_GITHUB_API_VERSION } : {}),
    };
}
export function buildCopilotDynamicHeaders(params) {
    return {
        ...buildCopilotIdeHeaders(),
        "Copilot-Integration-Id": "vscode-chat",
        "Openai-Organization": "github-copilot",
        "x-initiator": inferCopilotInitiator(params.messages),
        ...(params.hasImages ? { "Copilot-Vision-Request": "true" } : {}),
    };
}
