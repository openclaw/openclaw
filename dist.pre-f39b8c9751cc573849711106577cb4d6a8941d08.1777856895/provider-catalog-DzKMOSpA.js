import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-DR1voqtp.js";
import { t as modelCatalog } from "./openclaw.plugin-CtuGL2Rq.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
