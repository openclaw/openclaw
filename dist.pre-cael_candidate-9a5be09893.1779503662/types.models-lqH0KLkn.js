//#region src/config/types.models.ts
const MODEL_APIS = [
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"google-generative-ai",
	"github-copilot",
	"bedrock-converse-stream",
	"ollama",
	"azure-openai-responses"
];
const MODEL_THINKING_FORMATS = [
	"openai",
	"openrouter",
	"deepseek",
	"together",
	"qwen",
	"qwen-chat-template",
	"zai"
];
function isModelThinkingFormat(value) {
	return MODEL_THINKING_FORMATS.includes(value);
}
//#endregion
export { MODEL_THINKING_FORMATS as n, isModelThinkingFormat as r, MODEL_APIS as t };
