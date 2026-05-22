import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-Db90GZEt.js";
import { t as modelCatalog } from "./openclaw.plugin-M9ef1pj0.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
