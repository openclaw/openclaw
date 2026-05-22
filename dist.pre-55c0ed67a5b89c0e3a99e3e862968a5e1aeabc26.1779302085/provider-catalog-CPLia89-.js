import { a as normalizeModelCompat } from "./provider-model-compat-CmPOKTzc.js";
import "./provider-model-shared-DtsPmvDx.js";
//#region extensions/opencode-go/provider-catalog.ts
const PROVIDER_ID = "opencode-go";
const OPENCODE_GO_OPENAI_BASE_URL = "https://opencode.ai/zen/go/v1";
const OPENCODE_GO_ANTHROPIC_BASE_URL = "https://opencode.ai/zen/go";
const OPENCODE_GO_KIMI_NO_REASONING_MODEL_IDS = new Set(["kimi-k2.5", "kimi-k2.6"]);
const OPENCODE_GO_SUPPLEMENTAL_MODELS = [{
	id: "deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	api: "openai-completions",
	provider: PROVIDER_ID,
	baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
	reasoning: true,
	input: ["text"],
	cost: {
		input: 1.74,
		output: 3.48,
		cacheRead: .145,
		cacheWrite: 0
	},
	contextWindow: 1e6,
	maxTokens: 384e3,
	compat: {
		supportsUsageInStreaming: true,
		supportsReasoningEffort: true,
		maxTokensField: "max_tokens"
	}
}, {
	id: "deepseek-v4-flash",
	name: "DeepSeek V4 Flash",
	api: "openai-completions",
	provider: PROVIDER_ID,
	baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
	reasoning: true,
	input: ["text"],
	cost: {
		input: .14,
		output: .28,
		cacheRead: .028,
		cacheWrite: 0
	},
	contextWindow: 1e6,
	maxTokens: 384e3,
	compat: {
		supportsUsageInStreaming: true,
		supportsReasoningEffort: true,
		maxTokensField: "max_tokens"
	}
}].map((model) => normalizeModelCompat(model));
function listOpencodeGoSupplementalModelCatalogEntries() {
	return OPENCODE_GO_SUPPLEMENTAL_MODELS.map((model) => ({
		provider: model.provider,
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow
	}));
}
function resolveOpencodeGoSupplementalModel(modelId) {
	const normalizedModelId = modelId.trim().toLowerCase();
	return OPENCODE_GO_SUPPLEMENTAL_MODELS.find((model) => model.id === normalizedModelId);
}
function isOpencodeGoKimiNoReasoningModelId(modelId) {
	return typeof modelId === "string" && OPENCODE_GO_KIMI_NO_REASONING_MODEL_IDS.has(modelId.trim().toLowerCase());
}
function normalizeOpencodeGoResolvedModel(model) {
	if (!isOpencodeGoKimiNoReasoningModelId(model.id)) return;
	const compat = model.compat && typeof model.compat === "object" && !Array.isArray(model.compat) ? model.compat : void 0;
	if (!model.reasoning && !compat?.supportsReasoningEffort) return;
	return {
		...model,
		reasoning: false,
		compat: {
			...compat,
			supportsReasoningEffort: false
		}
	};
}
function normalizeBaseUrl(baseUrl) {
	return (baseUrl ?? "").trim().replace(/\/+$/, "");
}
function normalizeOpencodeGoBaseUrl(params) {
	const normalized = normalizeBaseUrl(params.baseUrl);
	if (!normalized) return;
	if (normalized === OPENCODE_GO_OPENAI_BASE_URL) return OPENCODE_GO_OPENAI_BASE_URL;
	if (normalized === OPENCODE_GO_ANTHROPIC_BASE_URL) return OPENCODE_GO_ANTHROPIC_BASE_URL;
	if (normalized === "https://opencode.ai/go") return OPENCODE_GO_ANTHROPIC_BASE_URL;
	if (normalized === "https://opencode.ai/go/v1") return params.api === "anthropic-messages" ? OPENCODE_GO_ANTHROPIC_BASE_URL : OPENCODE_GO_OPENAI_BASE_URL;
}
//#endregion
export { resolveOpencodeGoSupplementalModel as a, normalizeOpencodeGoResolvedModel as i, listOpencodeGoSupplementalModelCatalogEntries as n, normalizeOpencodeGoBaseUrl as r, isOpencodeGoKimiNoReasoningModelId as t };
