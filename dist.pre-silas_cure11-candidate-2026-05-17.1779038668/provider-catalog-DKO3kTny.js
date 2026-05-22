import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-Cwcla_Qt.js";
import { t as modelCatalog } from "./openclaw.plugin-CTRJq1HK.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
