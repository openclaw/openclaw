import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-a4yGG8eg.js";
import { t as modelCatalog } from "./openclaw.plugin-DZSAEq0c.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
