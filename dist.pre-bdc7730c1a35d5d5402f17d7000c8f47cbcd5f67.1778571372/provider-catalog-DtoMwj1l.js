import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-DnRgoEh-.js";
import { t as modelCatalog } from "./openclaw.plugin-gdXXoiCE.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
