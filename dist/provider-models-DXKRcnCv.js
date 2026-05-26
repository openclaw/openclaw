import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { a as normalizeModelCompat } from "./provider-model-compat-CmPOKTzc.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./provider-model-shared-DtsPmvDx.js";
import { t as normalizeXaiModelId } from "./model-id-BRM_wbb3.js";
import { d as resolveXaiCatalogEntry } from "./model-definitions-hd9WbvLm.js";
import { t as applyXaiRuntimeModelCompat } from "./runtime-model-compat-BW-NP6_x.js";
//#region extensions/xai/provider-models.ts
const XAI_MODERN_MODEL_PREFIXES = [
	"grok-build-0.1",
	"grok-4.3",
	"grok-4.20"
];
function isModernXaiModel(modelId) {
	const lower = normalizeOptionalLowercaseString(normalizeXaiModelId(modelId.trim())) ?? "";
	if (!lower || lower.includes("multi-agent")) return false;
	return XAI_MODERN_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}
function resolveXaiForwardCompatModel(params) {
	const definition = resolveXaiCatalogEntry(params.ctx.modelId);
	if (!definition) return;
	return applyXaiRuntimeModelCompat(normalizeModelCompat({
		id: definition.id,
		name: definition.name,
		api: params.ctx.providerConfig?.api ?? "openai-responses",
		provider: params.providerId,
		baseUrl: params.ctx.providerConfig?.baseUrl ?? "https://api.x.ai/v1",
		reasoning: definition.reasoning,
		input: definition.input,
		cost: definition.cost,
		contextWindow: definition.contextWindow,
		maxTokens: definition.maxTokens
	}));
}
//#endregion
export { resolveXaiForwardCompatModel as n, isModernXaiModel as t };
