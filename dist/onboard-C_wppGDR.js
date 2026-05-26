import { p as createModelCatalogPresetAppliers } from "./provider-onboard-MLXAQX8H.js";
import { n as TOGETHER_MODEL_CATALOG, r as buildTogetherModelDefinition, t as TOGETHER_BASE_URL } from "./models-AP1dobyb.js";
//#region extensions/together/onboard.ts
const TOGETHER_DEFAULT_MODEL_REF = "together/moonshotai/Kimi-K2.5";
const togetherPresetAppliers = createModelCatalogPresetAppliers({
	primaryModelRef: TOGETHER_DEFAULT_MODEL_REF,
	resolveParams: (_cfg) => ({
		providerId: "together",
		api: "openai-completions",
		baseUrl: TOGETHER_BASE_URL,
		catalogModels: TOGETHER_MODEL_CATALOG.map(buildTogetherModelDefinition),
		aliases: [{
			modelRef: TOGETHER_DEFAULT_MODEL_REF,
			alias: "Together AI"
		}]
	})
});
function applyTogetherConfig(cfg) {
	return togetherPresetAppliers.applyConfig(cfg);
}
//#endregion
export { applyTogetherConfig as n, TOGETHER_DEFAULT_MODEL_REF as t };
