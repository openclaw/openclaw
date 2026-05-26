import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-4kkagm5f.js";
import { t as modelCatalog } from "./openclaw.plugin-CdpzevYd.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
