import { p as createModelCatalogPresetAppliers } from "./provider-onboard-MLXAQX8H.js";
import { i as buildCerebrasModelDefinition, n as CEREBRAS_MODEL_CATALOG, t as CEREBRAS_BASE_URL } from "./models-C5vLETHx.js";
//#region extensions/cerebras/onboard.ts
const CEREBRAS_DEFAULT_MODEL_REF = "cerebras/zai-glm-4.7";
const cerebrasPresetAppliers = createModelCatalogPresetAppliers({
	primaryModelRef: CEREBRAS_DEFAULT_MODEL_REF,
	resolveParams: (_cfg) => ({
		providerId: "cerebras",
		api: "openai-completions",
		baseUrl: CEREBRAS_BASE_URL,
		catalogModels: CEREBRAS_MODEL_CATALOG.map(buildCerebrasModelDefinition),
		aliases: [{
			modelRef: CEREBRAS_DEFAULT_MODEL_REF,
			alias: "Cerebras GLM 4.7"
		}]
	})
});
function applyCerebrasConfig(cfg) {
	return cerebrasPresetAppliers.applyConfig(cfg);
}
//#endregion
export { applyCerebrasConfig as n, CEREBRAS_DEFAULT_MODEL_REF as t };
