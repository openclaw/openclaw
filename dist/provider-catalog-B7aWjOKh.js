import { a as DEEPINFRA_MODEL_CATALOG, o as buildDeepInfraModelDefinition, s as discoverDeepInfraModels, t as DEEPINFRA_BASE_URL } from "./provider-models-wxUkQkYA.js";
//#region extensions/deepinfra/provider-catalog.ts
function buildStaticDeepInfraProvider() {
	return {
		baseUrl: DEEPINFRA_BASE_URL,
		api: "openai-completions",
		models: DEEPINFRA_MODEL_CATALOG.map(buildDeepInfraModelDefinition)
	};
}
async function buildDeepInfraProvider() {
	return {
		baseUrl: DEEPINFRA_BASE_URL,
		api: "openai-completions",
		models: await discoverDeepInfraModels()
	};
}
//#endregion
export { buildStaticDeepInfraProvider as n, buildDeepInfraProvider as t };
