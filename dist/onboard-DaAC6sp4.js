import { p as createModelCatalogPresetAppliers } from "./provider-onboard-MLXAQX8H.js";
import { f as QWEN_CN_BASE_URL, g as QWEN_GLOBAL_BASE_URL, h as QWEN_DEFAULT_MODEL_REF, v as QWEN_STANDARD_CN_BASE_URL, y as QWEN_STANDARD_GLOBAL_BASE_URL } from "./models-D_eCLX7P.js";
import { n as buildQwenProvider } from "./provider-catalog-9QA674ve.js";
//#region extensions/qwen/onboard.ts
const qwenPresetAppliers = createModelCatalogPresetAppliers({
	primaryModelRef: QWEN_DEFAULT_MODEL_REF,
	resolveParams: (_cfg, baseUrl) => {
		const provider = buildQwenProvider({ baseUrl });
		return {
			providerId: "qwen",
			api: provider.api ?? "openai-completions",
			baseUrl,
			catalogModels: provider.models ?? [],
			aliases: [...(provider.models ?? []).flatMap((model) => [`qwen/${model.id}`, `modelstudio/${model.id}`]), {
				modelRef: QWEN_DEFAULT_MODEL_REF,
				alias: "Qwen"
			}]
		};
	}
});
function applyQwenProviderConfig(cfg) {
	return qwenPresetAppliers.applyProviderConfig(cfg, QWEN_GLOBAL_BASE_URL);
}
function applyQwenProviderConfigCn(cfg) {
	return qwenPresetAppliers.applyProviderConfig(cfg, QWEN_CN_BASE_URL);
}
function applyQwenConfig(cfg) {
	return qwenPresetAppliers.applyConfig(cfg, QWEN_GLOBAL_BASE_URL);
}
function applyQwenConfigCn(cfg) {
	return qwenPresetAppliers.applyConfig(cfg, QWEN_CN_BASE_URL);
}
function applyQwenStandardProviderConfig(cfg) {
	return qwenPresetAppliers.applyProviderConfig(cfg, QWEN_STANDARD_GLOBAL_BASE_URL);
}
function applyQwenStandardProviderConfigCn(cfg) {
	return qwenPresetAppliers.applyProviderConfig(cfg, QWEN_STANDARD_CN_BASE_URL);
}
function applyQwenStandardConfig(cfg) {
	return qwenPresetAppliers.applyConfig(cfg, QWEN_STANDARD_GLOBAL_BASE_URL);
}
function applyQwenStandardConfigCn(cfg) {
	return qwenPresetAppliers.applyConfig(cfg, QWEN_STANDARD_CN_BASE_URL);
}
const applyModelStudioProviderConfig = applyQwenProviderConfig;
const applyModelStudioProviderConfigCn = applyQwenProviderConfigCn;
const applyModelStudioConfig = applyQwenConfig;
const applyModelStudioConfigCn = applyQwenConfigCn;
const applyModelStudioStandardProviderConfig = applyQwenStandardProviderConfig;
const applyModelStudioStandardProviderConfigCn = applyQwenStandardProviderConfigCn;
const applyModelStudioStandardConfig = applyQwenStandardConfig;
const applyModelStudioStandardConfigCn = applyQwenStandardConfigCn;
//#endregion
export { applyModelStudioStandardConfig as a, applyModelStudioStandardProviderConfigCn as c, applyQwenStandardConfig as d, applyQwenStandardConfigCn as f, applyModelStudioProviderConfigCn as i, applyQwenConfig as l, applyModelStudioConfigCn as n, applyModelStudioStandardConfigCn as o, applyModelStudioProviderConfig as r, applyModelStudioStandardProviderConfig as s, applyModelStudioConfig as t, applyQwenConfigCn as u };
