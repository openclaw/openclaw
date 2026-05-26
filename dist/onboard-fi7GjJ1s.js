import { f as createDefaultModelsPresetAppliers } from "./provider-onboard-MLXAQX8H.js";
import { n as QIANFAN_DEFAULT_MODEL_ID, r as buildQianfanProvider } from "./provider-catalog-RV0Di9vu.js";
//#region extensions/qianfan/onboard.ts
const QIANFAN_DEFAULT_MODEL_REF = `qianfan/${QIANFAN_DEFAULT_MODEL_ID}`;
function resolveQianfanPreset(cfg) {
	const defaultProvider = buildQianfanProvider();
	const existingProvider = cfg.models?.providers?.qianfan;
	const existingBaseUrl = typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";
	return {
		api: typeof existingProvider?.api === "string" ? existingProvider.api : "openai-completions",
		baseUrl: existingBaseUrl || "https://qianfan.baidubce.com/v2",
		defaultModels: defaultProvider.models ?? []
	};
}
const qianfanPresetAppliers = createDefaultModelsPresetAppliers({
	primaryModelRef: QIANFAN_DEFAULT_MODEL_REF,
	resolveParams: (cfg) => {
		const preset = resolveQianfanPreset(cfg);
		return {
			providerId: "qianfan",
			api: preset.api,
			baseUrl: preset.baseUrl,
			defaultModels: preset.defaultModels,
			defaultModelId: QIANFAN_DEFAULT_MODEL_ID,
			aliases: [{
				modelRef: QIANFAN_DEFAULT_MODEL_REF,
				alias: "QIANFAN"
			}]
		};
	}
});
function applyQianfanProviderConfig(cfg) {
	return qianfanPresetAppliers.applyProviderConfig(cfg);
}
function applyQianfanConfig(cfg) {
	return qianfanPresetAppliers.applyConfig(cfg);
}
//#endregion
export { applyQianfanConfig as n, applyQianfanProviderConfig as r, QIANFAN_DEFAULT_MODEL_REF as t };
