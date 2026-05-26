import { p as createModelCatalogPresetAppliers } from "./provider-onboard-MLXAQX8H.js";
import { a as buildHuggingfaceModelDefinition, r as HUGGINGFACE_MODEL_CATALOG, t as HUGGINGFACE_BASE_URL } from "./models-EgyLPLps.js";
//#region extensions/huggingface/onboard.ts
const HUGGINGFACE_DEFAULT_MODEL_REF = "huggingface/deepseek-ai/DeepSeek-R1";
const huggingfacePresetAppliers = createModelCatalogPresetAppliers({
	primaryModelRef: HUGGINGFACE_DEFAULT_MODEL_REF,
	resolveParams: (_cfg) => ({
		providerId: "huggingface",
		api: "openai-completions",
		baseUrl: HUGGINGFACE_BASE_URL,
		catalogModels: HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition),
		aliases: [{
			modelRef: HUGGINGFACE_DEFAULT_MODEL_REF,
			alias: "Hugging Face"
		}]
	})
});
function applyHuggingfaceConfig(cfg) {
	return huggingfacePresetAppliers.applyConfig(cfg);
}
//#endregion
export { applyHuggingfaceConfig as n, HUGGINGFACE_DEFAULT_MODEL_REF as t };
