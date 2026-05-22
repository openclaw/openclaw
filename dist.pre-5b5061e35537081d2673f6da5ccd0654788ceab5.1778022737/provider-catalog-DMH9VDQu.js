import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BanUMnOe.js";
import { t as modelCatalog } from "./openclaw.plugin-DfW4Pg3u.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
