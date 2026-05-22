import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-DpGJVc_3.js";
import { t as modelCatalog } from "./openclaw.plugin-BC-386jD.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
