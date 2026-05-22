import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-CsCNdUte.js";
import { t as modelCatalog } from "./openclaw.plugin-DyKgnu1k.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
