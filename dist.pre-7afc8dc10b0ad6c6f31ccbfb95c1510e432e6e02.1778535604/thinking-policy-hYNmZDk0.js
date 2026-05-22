//#region extensions/amazon-bedrock/thinking-policy.ts
const BASE_CLAUDE_THINKING_LEVELS = [
	{ id: "off" },
	{ id: "minimal" },
	{ id: "low" },
	{ id: "medium" },
	{ id: "high" }
];
function isOpus47BedrockModelRef(modelRef) {
	return /(?:^|[/.:])(?:(?:us|eu|ap|apac|au|jp|global)\.)?anthropic\.claude-opus-4[.-]7(?:$|[-.:/])/i.test(modelRef);
}
function resolveBedrockClaudeThinkingProfile(modelId) {
	const trimmed = modelId.trim();
	if (isOpus47BedrockModelRef(trimmed)) return {
		levels: [
			...BASE_CLAUDE_THINKING_LEVELS,
			{ id: "xhigh" },
			{ id: "adaptive" },
			{ id: "max" }
		],
		defaultLevel: "off"
	};
	if (/claude-(?:opus|sonnet)-4(?:\.|-)6(?:$|[-.])/i.test(trimmed)) return {
		levels: [...BASE_CLAUDE_THINKING_LEVELS, { id: "adaptive" }],
		defaultLevel: "adaptive"
	};
	return { levels: BASE_CLAUDE_THINKING_LEVELS };
}
//#endregion
export { resolveBedrockClaudeThinkingProfile as n, isOpus47BedrockModelRef as t };
