import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-Dv7tLTgy.js";
import { t as modelCatalog } from "./openclaw.plugin-D238odJZ.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
