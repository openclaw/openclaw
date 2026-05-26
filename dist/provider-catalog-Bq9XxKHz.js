import { d as discoverKilocodeModels, l as KILOCODE_MODEL_CATALOG, r as KILOCODE_DEFAULT_COST, t as KILOCODE_BASE_URL } from "./provider-models-DFkSwbmo.js";
//#region extensions/kilocode/provider-catalog.ts
function buildKilocodeProvider() {
	return {
		baseUrl: KILOCODE_BASE_URL,
		api: "openai-completions",
		models: KILOCODE_MODEL_CATALOG.map((model) => ({
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: model.input,
			cost: KILOCODE_DEFAULT_COST,
			contextWindow: model.contextWindow ?? 1e6,
			maxTokens: model.maxTokens ?? 128e3
		}))
	};
}
async function buildKilocodeProviderWithDiscovery() {
	return {
		baseUrl: KILOCODE_BASE_URL,
		api: "openai-completions",
		models: await discoverKilocodeModels()
	};
}
//#endregion
export { buildKilocodeProviderWithDiscovery as n, buildKilocodeProvider as t };
