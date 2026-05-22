import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-DzoeYSYS.js";
import { t as modelCatalog } from "./openclaw.plugin-BLyifbu3.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
