import { p as createModelCatalogPresetAppliers } from "./provider-onboard-Bc2LmNr_.js";
import { i as buildVeniceModelDefinition, n as VENICE_DEFAULT_MODEL_REF, r as VENICE_MODEL_CATALOG, t as VENICE_BASE_URL } from "./models-BCIO-SBg.js";
import "./api-4o9_Pq7A.js";
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
