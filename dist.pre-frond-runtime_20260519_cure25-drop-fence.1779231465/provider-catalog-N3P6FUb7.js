import { r as buildCerebrasCatalogModels, t as CEREBRAS_BASE_URL } from "./models-CMR_3L_w.js";
//#region extensions/cerebras/provider-catalog.ts
function buildCerebrasProvider() {
	return {
		baseUrl: CEREBRAS_BASE_URL,
		api: "openai-completions",
		models: buildCerebrasCatalogModels()
	};
}
//#endregion
export { buildCerebrasProvider as t };
