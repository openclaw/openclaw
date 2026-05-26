import { i as buildTokenHubModelDefinition, n as TOKENHUB_MODEL_CATALOG, t as TOKENHUB_BASE_URL } from "./models-NbkgAGHo.js";
//#region extensions/tencent/provider-catalog.ts
function buildTokenHubProvider() {
	return {
		baseUrl: TOKENHUB_BASE_URL,
		api: "openai-completions",
		models: TOKENHUB_MODEL_CATALOG.map(buildTokenHubModelDefinition)
	};
}
//#endregion
export { buildTokenHubProvider as t };
