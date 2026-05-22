import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-C6L92Rnz.js";
import { t as modelCatalog } from "./openclaw.plugin-BcymyZb5.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
