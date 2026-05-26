import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BLp5nwNN.js";
import { t as modelCatalog } from "./openclaw.plugin-CzIsD0wt.js";
//#region extensions/mistral/model-definitions.ts
const MISTRAL_MANIFEST_CATALOG = modelCatalog.providers.mistral;
const MISTRAL_BASE_URL = MISTRAL_MANIFEST_CATALOG.baseUrl;
const MISTRAL_DEFAULT_MODEL_ID = "mistral-large-latest";
function requireMistralManifestModel(id) {
	const model = MISTRAL_MANIFEST_CATALOG.models.find((entry) => entry.id === id);
	if (!model) throw new Error(`Missing Mistral modelCatalog row ${id}`);
	return model;
}
const MISTRAL_DEFAULT_MANIFEST_MODEL = requireMistralManifestModel(MISTRAL_DEFAULT_MODEL_ID);
const MISTRAL_DEFAULT_CONTEXT_WINDOW = MISTRAL_DEFAULT_MANIFEST_MODEL.contextWindow;
const MISTRAL_DEFAULT_MAX_TOKENS = MISTRAL_DEFAULT_MANIFEST_MODEL.maxTokens;
const MISTRAL_DEFAULT_COST = MISTRAL_DEFAULT_MANIFEST_MODEL.cost;
function buildMistralModelDefinition() {
	const model = buildMistralCatalogModels().find((entry) => entry.id === MISTRAL_DEFAULT_MODEL_ID);
	if (!model) throw new Error(`Missing Mistral provider model ${MISTRAL_DEFAULT_MODEL_ID}`);
	return model;
}
function buildMistralCatalogModels() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: MISTRAL_MANIFEST_CATALOG
	}).models;
}
//#endregion
export { MISTRAL_DEFAULT_MODEL_ID as a, MISTRAL_DEFAULT_MAX_TOKENS as i, MISTRAL_DEFAULT_CONTEXT_WINDOW as n, buildMistralCatalogModels as o, MISTRAL_DEFAULT_COST as r, buildMistralModelDefinition as s, MISTRAL_BASE_URL as t };
