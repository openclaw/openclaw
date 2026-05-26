import { a as buildHuggingfaceModelDefinition, o as discoverHuggingfaceModels, r as HUGGINGFACE_MODEL_CATALOG, t as HUGGINGFACE_BASE_URL } from "./models-EgyLPLps.js";
//#region extensions/huggingface/provider-catalog.ts
async function buildHuggingfaceProvider(discoveryApiKey) {
	const resolvedSecret = discoveryApiKey?.trim() ?? "";
	return {
		baseUrl: HUGGINGFACE_BASE_URL,
		api: "openai-completions",
		models: resolvedSecret !== "" ? await discoverHuggingfaceModels(resolvedSecret) : HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition)
	};
}
//#endregion
export { buildHuggingfaceProvider as t };
