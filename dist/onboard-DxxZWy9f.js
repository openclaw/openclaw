import { f as createDefaultModelsPresetAppliers } from "./provider-onboard-MLXAQX8H.js";
import { n as buildXiaomiProvider, t as XIAOMI_DEFAULT_MODEL_ID } from "./provider-catalog-QeveciaQ.js";
//#region extensions/xiaomi/onboard.ts
const XIAOMI_DEFAULT_MODEL_REF = `xiaomi/${XIAOMI_DEFAULT_MODEL_ID}`;
const xiaomiPresetAppliers = createDefaultModelsPresetAppliers({
	primaryModelRef: XIAOMI_DEFAULT_MODEL_REF,
	resolveParams: (_cfg) => {
		const defaultProvider = buildXiaomiProvider();
		return {
			providerId: "xiaomi",
			api: defaultProvider.api ?? "openai-completions",
			baseUrl: defaultProvider.baseUrl,
			defaultModels: defaultProvider.models ?? [],
			defaultModelId: XIAOMI_DEFAULT_MODEL_ID,
			aliases: [{
				modelRef: XIAOMI_DEFAULT_MODEL_REF,
				alias: "Xiaomi"
			}]
		};
	}
});
function applyXiaomiProviderConfig(cfg) {
	return xiaomiPresetAppliers.applyProviderConfig(cfg);
}
function applyXiaomiConfig(cfg) {
	return xiaomiPresetAppliers.applyConfig(cfg);
}
//#endregion
export { applyXiaomiConfig as n, applyXiaomiProviderConfig as r, XIAOMI_DEFAULT_MODEL_REF as t };
