import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-D6Tgn3Fc.js";
import { t as modelCatalog } from "./openclaw.plugin-Bah8bJBa.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
