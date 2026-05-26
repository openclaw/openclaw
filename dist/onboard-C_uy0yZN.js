import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { u as applyProviderConfigWithModelCatalogPreset } from "./provider-onboard-MLXAQX8H.js";
import { a as ZAI_DEFAULT_MODEL_ID, c as buildZaiCatalogModels, u as resolveZaiBaseUrl } from "./model-definitions-B1PKfuNM.js";
//#region extensions/zai/onboard.ts
const ZAI_DEFAULT_MODEL_REF = `zai/${ZAI_DEFAULT_MODEL_ID}`;
function resolveZaiPresetBaseUrl(cfg, endpoint) {
	const existingProvider = cfg.models?.providers?.zai;
	const existingBaseUrl = normalizeOptionalString(existingProvider?.baseUrl) ?? "";
	return endpoint ? resolveZaiBaseUrl(endpoint) : existingBaseUrl || resolveZaiBaseUrl();
}
function applyZaiPreset(cfg, params, primaryModelRef) {
	const modelRef = `zai/${normalizeOptionalString(params?.modelId) ?? "glm-5.1"}`;
	return applyProviderConfigWithModelCatalogPreset(cfg, {
		providerId: "zai",
		api: "openai-completions",
		baseUrl: resolveZaiPresetBaseUrl(cfg, params?.endpoint),
		catalogModels: buildZaiCatalogModels(),
		aliases: [{
			modelRef,
			alias: "GLM"
		}],
		primaryModelRef
	});
}
function applyZaiProviderConfig(cfg, params) {
	return applyZaiPreset(cfg, params);
}
function applyZaiConfig(cfg, params) {
	const modelId = normalizeOptionalString(params?.modelId) ?? "glm-5.1";
	return applyZaiPreset(cfg, params, modelId === "glm-5.1" ? ZAI_DEFAULT_MODEL_REF : `zai/${modelId}`);
}
//#endregion
export { applyZaiConfig as n, applyZaiProviderConfig as r, ZAI_DEFAULT_MODEL_REF as t };
