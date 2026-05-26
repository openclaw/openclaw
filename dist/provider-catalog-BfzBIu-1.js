import { a as buildSyntheticModelDefinition, i as SYNTHETIC_MODEL_CATALOG, t as SYNTHETIC_BASE_URL } from "./models-DLl1wgKa.js";
//#region extensions/synthetic/provider-catalog.ts
function buildSyntheticProvider() {
	return {
		baseUrl: SYNTHETIC_BASE_URL,
		api: "anthropic-messages",
		models: SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition)
	};
}
//#endregion
export { buildSyntheticProvider as t };
