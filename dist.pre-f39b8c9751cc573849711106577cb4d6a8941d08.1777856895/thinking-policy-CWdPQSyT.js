//#region extensions/openai/thinking-policy.ts
const OPENAI_THINKING_BASE_LEVELS = [
	{ id: "off" },
	{ id: "minimal" },
	{ id: "low" },
	{ id: "medium" },
	{ id: "high" }
];
const OPENAI_XHIGH_MODEL_IDS = [
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.4",
	"gpt-5.4-pro",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.2"
];
const OPENAI_CODEX_XHIGH_MODEL_IDS = [
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.4",
	"gpt-5.4-pro",
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5.1-codex"
];
function normalizeModelId(value) {
	return value.trim().toLowerCase();
}
function matchesExactOrPrefix(id, values) {
	const normalizedId = normalizeModelId(id);
	return values.some((value) => {
		const normalizedValue = normalizeModelId(value);
		return normalizedId === normalizedValue || normalizedId.startsWith(normalizedValue);
	});
}
function buildOpenAIThinkingProfile(params) {
	return { levels: [...OPENAI_THINKING_BASE_LEVELS, ...matchesExactOrPrefix(params.modelId, params.xhighModelIds) ? [{ id: "xhigh" }] : []] };
}
function resolveOpenAIThinkingProfile(modelId) {
	return buildOpenAIThinkingProfile({
		modelId,
		xhighModelIds: OPENAI_XHIGH_MODEL_IDS
	});
}
function resolveOpenAICodexThinkingProfile(modelId) {
	return buildOpenAIThinkingProfile({
		modelId,
		xhighModelIds: OPENAI_CODEX_XHIGH_MODEL_IDS
	});
}
//#endregion
export { resolveOpenAIThinkingProfile as n, resolveOpenAICodexThinkingProfile as t };
