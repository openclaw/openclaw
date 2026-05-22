import { p as createModelCatalogPresetAppliers } from "./provider-onboard-CcvyqGAT.js";
import { i as buildVeniceModelDefinition, n as VENICE_DEFAULT_MODEL_REF, r as VENICE_MODEL_CATALOG, t as VENICE_BASE_URL } from "./models-84u_3cL7.js";
import "./api-Dx-sUQMd.js";
//#region extensions/venice/onboard.ts
const venicePresetAppliers = createModelCatalogPresetAppliers({
	primaryModelRef: VENICE_DEFAULT_MODEL_REF,
	resolveParams: (_cfg) => ({
		providerId: "venice",
		api: "openai-completions",
		baseUrl: VENICE_BASE_URL,
		catalogModels: VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition),
		aliases: [{
			modelRef: VENICE_DEFAULT_MODEL_REF,
			alias: "Kimi K2.5"
		}]
	})
});
function applyVeniceConfig(cfg) {
	return venicePresetAppliers.applyConfig(cfg);
}
//#endregion
export { applyVeniceConfig as t };
