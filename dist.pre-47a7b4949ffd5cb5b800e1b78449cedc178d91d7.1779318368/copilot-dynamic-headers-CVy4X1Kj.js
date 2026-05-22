//#region src/agents/copilot-dynamic-headers.ts
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
const COPILOT_EDITOR_VERSION = "vscode/1.107.0";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
const COPILOT_USER_AGENT = "GitHubCopilotChat/0.35.0";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
const COPILOT_EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
const COPILOT_GITHUB_API_VERSION = "2025-04-01";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
const COPILOT_INTEGRATION_ID = "vscode-chat";
/** @deprecated GitHub Copilot provider-owned helper; do not use from third-party plugins. */
function buildCopilotIdeHeaders(params = {}) {
	return {
		"Accept-Encoding": "identity",
		"Editor-Version": COPILOT_EDITOR_VERSION,
		"Editor-Plugin-Version": COPILOT_EDITOR_PLUGIN_VERSION,
		"User-Agent": COPILOT_USER_AGENT,
		...params.includeApiVersion ? { "X-Github-Api-Version": COPILOT_GITHUB_API_VERSION } : {}
	};
}
function inferCopilotInitiator(messages) {
	const last = messages[messages.length - 1];
	if (!last) return "user";
	if (last.role === "user" && containsCopilotContentType(last.content, "tool_result")) return "agent";
	return last.role === "user" ? "user" : "agent";
}
function containsCopilotContentType(value, type) {
	if (Array.isArray(value)) return value.some((item) => containsCopilotContentType(item, type));
	if (!value || typeof value !== "object") return false;
	const entry = value;
	return entry.type === type || containsCopilotContentType(entry.content, type);
}
function hasCopilotVisionInput(messages) {
	return messages.some((message) => {
		if (message.role === "user" && Array.isArray(message.content)) return message.content.some((item) => containsCopilotContentType(item, "image"));
		if (message.role === "toolResult" && Array.isArray(message.content)) return message.content.some((item) => containsCopilotContentType(item, "image"));
		return false;
	});
}
function buildCopilotDynamicHeaders(params) {
	return {
		...buildCopilotIdeHeaders(),
		"Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
		"Openai-Organization": "github-copilot",
		"x-initiator": inferCopilotInitiator(params.messages),
		...params.hasImages ? { "Copilot-Vision-Request": "true" } : {}
	};
}
//#endregion
export { COPILOT_USER_AGENT as a, hasCopilotVisionInput as c, COPILOT_INTEGRATION_ID as i, COPILOT_EDITOR_VERSION as n, buildCopilotDynamicHeaders as o, COPILOT_GITHUB_API_VERSION as r, buildCopilotIdeHeaders as s, COPILOT_EDITOR_PLUGIN_VERSION as t };
