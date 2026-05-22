import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-DR1voqtp.js";
import { t as modelCatalog } from "./openclaw.plugin-B_fVAw43.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
