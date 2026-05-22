import { expect } from "vitest";
//#region extensions/google/google-shared.test-helpers.ts
function makeZeroUsageSnapshot() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		reasoningTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
const asRecord = (value) => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected record");
	return value;
};
const getFirstToolParameters = (converted) => {
	const functionDeclaration = asRecord(converted?.[0]?.functionDeclarations?.[0]);
	return asRecord(functionDeclaration.parametersJsonSchema ?? functionDeclaration.parameters);
};
const makeModel = (id) => ({
	id,
	name: id,
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0
	},
	contextWindow: 1,
	maxTokens: 1
});
const makeGeminiCliModel = (id) => ({
	id,
	name: id,
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0
	},
	contextWindow: 1,
	maxTokens: 1
});
function makeGoogleAssistantMessage(model, content) {
	return {
		role: "assistant",
		content,
		api: "google-generative-ai",
		provider: "google",
		model,
		usage: makeZeroUsageSnapshot(),
		stopReason: "stop",
		timestamp: 0
	};
}
function makeGeminiCliAssistantMessage(model, content) {
	return {
		role: "assistant",
		content,
		api: "google-gemini-cli",
		provider: "google-gemini-cli",
		model,
		usage: makeZeroUsageSnapshot(),
		stopReason: "stop",
		timestamp: 0
	};
}
function expectConvertedRoles(contents, expectedRoles) {
	expect(contents).toHaveLength(expectedRoles.length);
	for (const [index, role] of expectedRoles.entries()) expect(contents[index]?.role).toBe(role);
}
//#endregion
export { asRecord, expectConvertedRoles, getFirstToolParameters, makeGeminiCliAssistantMessage, makeGeminiCliModel, makeGoogleAssistantMessage, makeModel };
