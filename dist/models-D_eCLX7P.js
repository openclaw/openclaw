import { o as supportsNativeStreamingUsageCompat, t as applyProviderNativeStreamingUsageCompat } from "./provider-catalog-shared-BLp5nwNN.js";
//#region extensions/qwen/models.ts
const QWEN_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
const QWEN_GLOBAL_BASE_URL = QWEN_BASE_URL;
const QWEN_CN_BASE_URL = "https://coding.dashscope.aliyuncs.com/v1";
const QWEN_STANDARD_CN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const QWEN_STANDARD_GLOBAL_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const QWEN_DEFAULT_MODEL_ID = "qwen3.5-plus";
const QWEN_36_PLUS_MODEL_ID = "qwen3.6-plus";
const QWEN_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const QWEN_DEFAULT_MODEL_REF = `qwen/${QWEN_DEFAULT_MODEL_ID}`;
const QWEN_MODEL_CATALOG = [
	{
		id: "qwen3.5-plus",
		name: "qwen3.5-plus",
		reasoning: false,
		input: ["text", "image"],
		cost: QWEN_DEFAULT_COST,
		contextWindow: 1e6,
		maxTokens: 65536
	},
	{
		id: QWEN_36_PLUS_MODEL_ID,
		name: QWEN_36_PLUS_MODEL_ID,
		reasoning: false,
		input: ["text", "image"],
		cost: QWEN_DEFAULT_COST,
		contextWindow: 1e6,
		maxTokens: 65536
	},
	{
		id: "qwen3-max-2026-01-23",
		name: "qwen3-max-2026-01-23",
		reasoning: false,
		input: ["text"],
		cost: QWEN_DEFAULT_COST,
		contextWindow: 262144,
		maxTokens: 65536
	},
	{
		id: "qwen3-coder-next",
		name: "qwen3-coder-next",
		reasoning: false,
		input: ["text"],
		cost: QWEN_DEFAULT_COST,
		contextWindow: 262144,
		maxTokens: 65536
	},
	{
		id: "qwen3-coder-plus",
		name: "qwen3-coder-plus",
		reasoning: false,
		input: ["text"],
		cost: QWEN_DEFAULT_COST,
		contextWindow: 1e6,
		maxTokens: 65536
	},
	{
		id: "MiniMax-M2.5",
		name: "MiniMax-M2.5",
		reasoning: true,
		input: ["text"],
		cost: QWEN_DEFAULT_COST,
		contextWindow: 1e6,
		maxTokens: 65536
	},
	{
		id: "glm-5",
		name: "glm-5",
		reasoning: false,
		input: ["text"],
		cost: QWEN_DEFAULT_COST,
		contextWindow: 202752,
		maxTokens: 16384
	},
	{
		id: "glm-4.7",
		name: "glm-4.7",
		reasoning: false,
		input: ["text"],
		cost: QWEN_DEFAULT_COST,
		contextWindow: 202752,
		maxTokens: 16384
	},
	{
		id: "kimi-k2.5",
		name: "kimi-k2.5",
		reasoning: false,
		input: ["text", "image"],
		cost: QWEN_DEFAULT_COST,
		contextWindow: 262144,
		maxTokens: 32768
	}
];
function isQwenCodingPlanBaseUrl(baseUrl) {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return false;
	try {
		const hostname = new URL(trimmed).hostname.toLowerCase().replace(/\.+$/, "");
		return hostname === "coding.dashscope.aliyuncs.com" || hostname === "coding-intl.dashscope.aliyuncs.com";
	} catch {
		return false;
	}
}
function isQwen36PlusSupportedBaseUrl(baseUrl) {
	return !isQwenCodingPlanBaseUrl(baseUrl);
}
function buildQwenModelCatalogForBaseUrl(baseUrl) {
	return isQwen36PlusSupportedBaseUrl(baseUrl) ? QWEN_MODEL_CATALOG : QWEN_MODEL_CATALOG.filter((model) => model.id !== QWEN_36_PLUS_MODEL_ID);
}
function isNativeQwenBaseUrl(baseUrl) {
	return supportsNativeStreamingUsageCompat({
		providerId: "qwen",
		baseUrl
	});
}
function applyQwenNativeStreamingUsageCompat(provider) {
	return applyProviderNativeStreamingUsageCompat({
		providerId: "qwen",
		providerConfig: provider
	});
}
function buildQwenModelDefinition(params) {
	const catalog = QWEN_MODEL_CATALOG.find((model) => model.id === params.id);
	return {
		id: params.id,
		name: params.name ?? catalog?.name ?? params.id,
		reasoning: params.reasoning ?? catalog?.reasoning ?? false,
		input: params.input ?? (catalog?.input ? [...catalog.input] : ["text"]),
		cost: params.cost ?? catalog?.cost ?? QWEN_DEFAULT_COST,
		contextWindow: params.contextWindow ?? catalog?.contextWindow ?? 262144,
		maxTokens: params.maxTokens ?? catalog?.maxTokens ?? 65536
	};
}
function buildQwenDefaultModelDefinition() {
	return buildQwenModelDefinition({ id: QWEN_DEFAULT_MODEL_ID });
}
/** @deprecated Use QWEN_BASE_URL. */
const MODELSTUDIO_BASE_URL = QWEN_BASE_URL;
/** @deprecated Use QWEN_GLOBAL_BASE_URL. */
const MODELSTUDIO_GLOBAL_BASE_URL = QWEN_GLOBAL_BASE_URL;
/** @deprecated Use QWEN_CN_BASE_URL. */
const MODELSTUDIO_CN_BASE_URL = QWEN_CN_BASE_URL;
/** @deprecated Use QWEN_STANDARD_CN_BASE_URL. */
const MODELSTUDIO_STANDARD_CN_BASE_URL = QWEN_STANDARD_CN_BASE_URL;
/** @deprecated Use QWEN_STANDARD_GLOBAL_BASE_URL. */
const MODELSTUDIO_STANDARD_GLOBAL_BASE_URL = QWEN_STANDARD_GLOBAL_BASE_URL;
/** @deprecated Use QWEN_DEFAULT_MODEL_ID. */
const MODELSTUDIO_DEFAULT_MODEL_ID = QWEN_DEFAULT_MODEL_ID;
/** @deprecated Use QWEN_DEFAULT_COST. */
const MODELSTUDIO_DEFAULT_COST = QWEN_DEFAULT_COST;
/** @deprecated Use qwen/${QWEN_DEFAULT_MODEL_ID}. */
const MODELSTUDIO_DEFAULT_MODEL_REF = `modelstudio/${QWEN_DEFAULT_MODEL_ID}`;
/** @deprecated Use QWEN_MODEL_CATALOG. */
const MODELSTUDIO_MODEL_CATALOG = QWEN_MODEL_CATALOG;
const isNativeModelStudioBaseUrl = isNativeQwenBaseUrl;
const applyModelStudioNativeStreamingUsageCompat = applyQwenNativeStreamingUsageCompat;
const buildModelStudioModelDefinition = buildQwenModelDefinition;
const buildModelStudioDefaultModelDefinition = buildQwenDefaultModelDefinition;
//#endregion
export { isQwenCodingPlanBaseUrl as A, buildModelStudioModelDefinition as C, isNativeModelStudioBaseUrl as D, buildQwenModelDefinition as E, isNativeQwenBaseUrl as O, buildModelStudioDefaultModelDefinition as S, buildQwenModelCatalogForBaseUrl as T, QWEN_MODEL_CATALOG as _, MODELSTUDIO_DEFAULT_MODEL_REF as a, applyModelStudioNativeStreamingUsageCompat as b, MODELSTUDIO_STANDARD_CN_BASE_URL as c, QWEN_BASE_URL as d, QWEN_CN_BASE_URL as f, QWEN_GLOBAL_BASE_URL as g, QWEN_DEFAULT_MODEL_REF as h, MODELSTUDIO_DEFAULT_MODEL_ID as i, isQwen36PlusSupportedBaseUrl as k, MODELSTUDIO_STANDARD_GLOBAL_BASE_URL as l, QWEN_DEFAULT_MODEL_ID as m, MODELSTUDIO_CN_BASE_URL as n, MODELSTUDIO_GLOBAL_BASE_URL as o, QWEN_DEFAULT_COST as p, MODELSTUDIO_DEFAULT_COST as r, MODELSTUDIO_MODEL_CATALOG as s, MODELSTUDIO_BASE_URL as t, QWEN_36_PLUS_MODEL_ID as u, QWEN_STANDARD_CN_BASE_URL as v, buildQwenDefaultModelDefinition as w, applyQwenNativeStreamingUsageCompat as x, QWEN_STANDARD_GLOBAL_BASE_URL as y };
