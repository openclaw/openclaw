import { a as discoverVeniceModels, t as VENICE_BASE_URL } from "./models-DERiILZ2.js";
//#region extensions/venice/provider-catalog.ts
async function buildVeniceProvider() {
	return {
		baseUrl: VENICE_BASE_URL,
		api: "openai-completions",
		models: await discoverVeniceModels()
	};
}
//#endregion
export { buildVeniceProvider as t };
