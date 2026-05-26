import { a as buildChutesModelDefinition, i as CHUTES_MODEL_CATALOG, s as discoverChutesModels, t as CHUTES_BASE_URL } from "./models-DkGbHMZb.js";
//#region extensions/chutes/provider-catalog.ts
function buildStaticChutesProvider() {
	return {
		baseUrl: CHUTES_BASE_URL,
		api: "openai-completions",
		models: CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition)
	};
}
/**
* Build the Chutes provider with dynamic model discovery.
* Falls back to the static catalog on failure.
* Accepts an optional access token (API key or OAuth access token) for authenticated discovery.
*/
async function buildChutesProvider(accessToken) {
	const models = await discoverChutesModels(accessToken);
	return {
		baseUrl: CHUTES_BASE_URL,
		api: "openai-completions",
		models: models.length > 0 ? models : CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition)
	};
}
//#endregion
export { buildStaticChutesProvider as n, buildChutesProvider as t };
