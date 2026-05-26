import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BLp5nwNN.js";
import { t as modelCatalog } from "./openclaw.plugin-Ca6Sljk7.js";
//#region extensions/byteplus/models.ts
const BYTEPLUS_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
	providerId: "byteplus",
	catalog: modelCatalog.providers.byteplus
});
const BYTEPLUS_CODING_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
	providerId: "byteplus-plan",
	catalog: modelCatalog.providers["byteplus-plan"]
});
const BYTEPLUS_BASE_URL = BYTEPLUS_MANIFEST_PROVIDER.baseUrl;
const BYTEPLUS_CODING_BASE_URL = BYTEPLUS_CODING_MANIFEST_PROVIDER.baseUrl;
const BYTEPLUS_DEFAULT_COST = {
	input: 1e-4,
	output: 2e-4,
	cacheRead: 0,
	cacheWrite: 0
};
const BYTEPLUS_MODEL_CATALOG = BYTEPLUS_MANIFEST_PROVIDER.models;
const BYTEPLUS_CODING_MODEL_CATALOG = BYTEPLUS_CODING_MANIFEST_PROVIDER.models;
function buildBytePlusModelDefinition(entry) {
	return {
		...entry,
		input: [...entry.input],
		cost: { ...entry.cost }
	};
}
//#endregion
export { BYTEPLUS_MODEL_CATALOG as a, BYTEPLUS_DEFAULT_COST as i, BYTEPLUS_CODING_BASE_URL as n, buildBytePlusModelDefinition as o, BYTEPLUS_CODING_MODEL_CATALOG as r, BYTEPLUS_BASE_URL as t };
