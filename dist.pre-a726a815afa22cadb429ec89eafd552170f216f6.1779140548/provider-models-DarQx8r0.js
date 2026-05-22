import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { a as normalizeModelCompat } from "./provider-model-compat-C4-MXeIm.js";
import "./provider-model-shared-DBCMc-LA.js";
import "./string-coerce-runtime-vNMR229H.js";
import { d as resolveXaiCatalogEntry } from "./model-definitions-C57rQNZ6.js";
import { t as applyXaiRuntimeModelCompat } from "./runtime-model-compat-BZXEQnqT.js";
//#region extensions/xai/provider-models.ts
const XAI_MODERN_MODEL_PREFIXES = ["grok-4.3", "grok-4.20"];
function isModernXaiModel(modelId) {
	const lower = normalizeOptionalLowercaseString(modelId) ?? "";
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
