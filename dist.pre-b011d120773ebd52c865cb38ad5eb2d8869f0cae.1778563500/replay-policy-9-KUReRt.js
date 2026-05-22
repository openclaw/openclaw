//#region extensions/openai/replay-policy.ts
/**
* Returns the provider-owned replay policy for OpenAI-family transports.
*/
function buildOpenAIReplayPolicy(ctx) {
	return {
		sanitizeMode: "images-only",
		applyAssistantFirstOrderingFix: false,
		validateGeminiTurns: false,
		validateAnthropicTurns: false,
		...ctx.modelApi === "openai-completions" ? {
			sanitizeToolCallIds: true,
			toolCallIdMode: "strict"
		} : { sanitizeToolCallIds: false }
	};
}
//#endregion
export { buildOpenAIReplayPolicy as t };
