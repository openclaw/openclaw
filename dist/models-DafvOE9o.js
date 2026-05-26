import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BLp5nwNN.js";
import { t as modelCatalog } from "./openclaw.plugin-C5D28Bj3.js";
//#region extensions/volcengine/models.ts
const DOUBAO_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
	providerId: "volcengine",
	catalog: modelCatalog.providers.volcengine
});
const DOUBAO_CODING_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
	providerId: "volcengine-plan",
	catalog: modelCatalog.providers["volcengine-plan"]
});
const DOUBAO_BASE_URL = DOUBAO_MANIFEST_PROVIDER.baseUrl;
const DOUBAO_CODING_BASE_URL = DOUBAO_CODING_MANIFEST_PROVIDER.baseUrl;
const DOUBAO_MODEL_CATALOG = DOUBAO_MANIFEST_PROVIDER.models;
const DOUBAO_CODING_MODEL_CATALOG = DOUBAO_CODING_MANIFEST_PROVIDER.models;
function buildDoubaoModelDefinition(entry) {
	return {
		...entry,
		input: [...entry.input],
		cost: { ...entry.cost }
	};
}
//#endregion
export { buildDoubaoModelDefinition as a, DOUBAO_MODEL_CATALOG as i, DOUBAO_CODING_BASE_URL as n, DOUBAO_CODING_MODEL_CATALOG as r, DOUBAO_BASE_URL as t };
