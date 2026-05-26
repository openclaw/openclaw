//#region extensions/groq/api.ts
const GROQ_QWEN3_32B_ID = "qwen/qwen3-32b";
const GROQ_GPT_OSS_REASONING_IDS = new Set([
	"openai/gpt-oss-20b",
	"openai/gpt-oss-120b",
	"openai/gpt-oss-safeguard-20b"
]);
const GROQ_QWEN_REASONING_EFFORTS = ["none", "default"];
const GROQ_GPT_OSS_REASONING_EFFORTS = [
	"low",
	"medium",
	"high"
];
const GROQ_QWEN_REASONING_EFFORT_MAP = {
	off: "none",
	none: "none",
	minimal: "default",
	low: "default",
	medium: "default",
	high: "default",
	xhigh: "default",
	adaptive: "default",
	max: "default"
};
function normalizeGroqModelId(modelId) {
	return modelId?.trim().toLowerCase() ?? "";
}
function resolveGroqReasoningCompatPatch(modelId) {
	const normalized = normalizeGroqModelId(modelId);
	if (normalized === GROQ_QWEN3_32B_ID) return {
		supportsReasoningEffort: true,
		supportedReasoningEfforts: [...GROQ_QWEN_REASONING_EFFORTS],
		reasoningEffortMap: GROQ_QWEN_REASONING_EFFORT_MAP
	};
	if (GROQ_GPT_OSS_REASONING_IDS.has(normalized)) return {
		supportsReasoningEffort: true,
		supportedReasoningEfforts: [...GROQ_GPT_OSS_REASONING_EFFORTS]
	};
	return null;
}
function contributeGroqResolvedModelCompat(params) {
	if (params.model.api !== "openai-completions" || params.model.provider !== "groq") return;
	return resolveGroqReasoningCompatPatch(params.modelId) ?? void 0;
}
//#endregion
export { resolveGroqReasoningCompatPatch as n, contributeGroqResolvedModelCompat as t };
