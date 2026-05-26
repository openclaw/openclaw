import { p as createModelCatalogPresetAppliers } from "./provider-onboard-MLXAQX8H.js";
import { s as KILOCODE_DEFAULT_MODEL_REF, t as KILOCODE_BASE_URL } from "./provider-models-DFkSwbmo.js";
import { t as buildKilocodeProvider } from "./provider-catalog-Bq9XxKHz.js";
//#region extensions/kilocode/onboard.ts
const kilocodePresetAppliers = createModelCatalogPresetAppliers({
	primaryModelRef: KILOCODE_DEFAULT_MODEL_REF,
	resolveParams: (_cfg) => ({
		providerId: "kilocode",
		api: "openai-completions",
		baseUrl: KILOCODE_BASE_URL,
		catalogModels: buildKilocodeProvider().models ?? [],
		aliases: [{
			modelRef: KILOCODE_DEFAULT_MODEL_REF,
			alias: "Kilo Gateway"
		}]
	})
});
function applyKilocodeProviderConfig(cfg) {
	return kilocodePresetAppliers.applyProviderConfig(cfg);
}
function applyKilocodeConfig(cfg) {
	return kilocodePresetAppliers.applyConfig(cfg);
}
//#endregion
export { applyKilocodeProviderConfig as n, applyKilocodeConfig as t };
