import { n as DEEPSEEK_MODEL_CATALOG, r as buildDeepSeekModelDefinition, t as DEEPSEEK_BASE_URL } from "./models-CMCEiKpv.js";
//#region extensions/deepseek/provider-catalog.ts
function buildDeepSeekProvider() {
	return {
		baseUrl: DEEPSEEK_BASE_URL,
		api: "openai-completions",
		models: DEEPSEEK_MODEL_CATALOG.map(buildDeepSeekModelDefinition)
	};
}
//#endregion
export { buildDeepSeekProvider as t };
