import { a as discoverVeniceModels, t as VENICE_BASE_URL } from "./models-CxpbB2AP.js";
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
