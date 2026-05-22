import { a as discoverVeniceModels, t as VENICE_BASE_URL } from "./models-C9NS_XqH.js";
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
