import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-DzoeYSYS.js";
import { t as modelCatalog } from "./openclaw.plugin-gsdATO9f.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
