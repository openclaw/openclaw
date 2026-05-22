import { o as buildLitellmModelDefinition, t as LITELLM_BASE_URL } from "./onboard-C4zeog_I.js";
//#region extensions/litellm/provider-catalog.ts
function buildLitellmProvider() {
	return {
		baseUrl: LITELLM_BASE_URL,
		api: "openai-completions",
		models: [buildLitellmModelDefinition()]
	};
}
//#endregion
export { buildLitellmProvider as t };
