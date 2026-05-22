//#region extensions/codex/provider-catalog.ts
const CODEX_PROVIDER_ID = "codex";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_APP_SERVER_AUTH_MARKER = "codex-app-server";
const DEFAULT_CONTEXT_WINDOW = 272e3;
const DEFAULT_MAX_TOKENS = 128e3;
const FALLBACK_CODEX_MODELS = [
	{
		id: "gpt-5.5",
		model: "gpt-5.5",
		displayName: "gpt-5.5",
		description: "Latest frontier agentic coding model.",
		isDefault: true,
		inputModalities: ["text", "image"],
		supportedReasoningEfforts: [
			"low",
			"medium",
			"high",
			"xhigh"
		]
	},
	{
		id: "gpt-5.4-mini",
		model: "gpt-5.4-mini",
		displayName: "GPT-5.4-Mini",
		description: "Smaller frontier agentic coding model.",
		inputModalities: ["text", "image"],
		supportedReasoningEfforts: [
			"low",
			"medium",
			"high",
			"xhigh"
		]
	},
	{
		id: "gpt-5.2",
		model: "gpt-5.2",
		displayName: "gpt-5.2",
		inputModalities: ["text", "image"],
		supportedReasoningEfforts: [
			"low",
			"medium",
			"high",
			"xhigh"
		]
	}
];
function buildCodexModelDefinition(model) {
	const id = model.id.trim() || model.model.trim();
	return {
		id,
		name: model.displayName?.trim() || id,
		api: "openai-codex-responses",
		reasoning: model.supportedReasoningEfforts.length > 0 || shouldDefaultToReasoningModel(id),
		input: model.inputModalities.includes("image") ? ["text", "image"] : ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		compat: {
			supportsReasoningEffort: model.supportedReasoningEfforts.length > 0,
			supportsUsageInStreaming: true
		}
	};
}
function buildCodexProviderConfig(models) {
	return {
		baseUrl: CODEX_BASE_URL,
		apiKey: CODEX_APP_SERVER_AUTH_MARKER,
		auth: "token",
		api: "openai-codex-responses",
		models: models.map(buildCodexModelDefinition)
	};
}
function shouldDefaultToReasoningModel(modelId) {
	const lower = modelId.toLowerCase();
	return lower.startsWith("gpt-5") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4");
}
//#endregion
export { buildCodexModelDefinition as a, FALLBACK_CODEX_MODELS as i, CODEX_BASE_URL as n, buildCodexProviderConfig as o, CODEX_PROVIDER_ID as r, CODEX_APP_SERVER_AUTH_MARKER as t };
