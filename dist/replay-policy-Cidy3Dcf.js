//#region extensions/openai/replay-policy.ts
const RESPONSES_FAMILY_APIS = new Set([
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses"
]);
/**
* Returns the provider-owned replay policy for OpenAI-family transports.
*/
function buildOpenAIReplayPolicy(ctx) {
	return {
		sanitizeMode: "images-only",
		applyAssistantFirstOrderingFix: false,
		validateGeminiTurns: false,
		validateAnthropicTurns: false,
		...RESPONSES_FAMILY_APIS.has(ctx.modelApi ?? "") ? { allowSyntheticToolResults: true } : {},
		...ctx.modelApi === "openai-completions" ? {
			sanitizeToolCallIds: true,
			toolCallIdMode: "strict"
		} : { sanitizeToolCallIds: false }
	};
}
//#endregion
export { buildOpenAIReplayPolicy as t };
