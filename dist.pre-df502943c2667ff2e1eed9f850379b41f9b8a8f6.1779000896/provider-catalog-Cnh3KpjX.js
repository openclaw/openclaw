import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-B_DVwuDx.js";
import { t as modelCatalog } from "./openclaw.plugin-C3OVP4Co.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
