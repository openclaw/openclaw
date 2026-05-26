import { p as createModelCatalogPresetAppliers } from "./provider-onboard-MLXAQX8H.js";
import { a as buildSyntheticModelDefinition, i as SYNTHETIC_MODEL_CATALOG, r as SYNTHETIC_DEFAULT_MODEL_REF, t as SYNTHETIC_BASE_URL } from "./models-DVAi2b9h2.js";
//#region extensions/synthetic/onboard.ts
const syntheticPresetAppliers = createModelCatalogPresetAppliers({
	primaryModelRef: SYNTHETIC_DEFAULT_MODEL_REF,
	resolveParams: (_cfg) => ({
		providerId: "synthetic",
		api: "anthropic-messages",
		baseUrl: SYNTHETIC_BASE_URL,
		catalogModels: SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition),
		aliases: [{
			modelRef: SYNTHETIC_DEFAULT_MODEL_REF,
			alias: "MiniMax M2.5"
		}]
	})
});
function applySyntheticProviderConfig(cfg) {
	return syntheticPresetAppliers.applyProviderConfig(cfg);
}
function applySyntheticConfig(cfg) {
	return syntheticPresetAppliers.applyConfig(cfg);
}
//#endregion
export { applySyntheticProviderConfig as n, applySyntheticConfig as t };
