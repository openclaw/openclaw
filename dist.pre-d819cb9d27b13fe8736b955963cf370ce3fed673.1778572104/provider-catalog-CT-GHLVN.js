import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-DpGJVc_3.js";
import { t as modelCatalog } from "./openclaw.plugin-oB5chHjx.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
