import { o as buildLitellmModelDefinition, t as LITELLM_BASE_URL } from "./onboard-m-3wT_Z3.js";
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
