import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-DMXBCanM.js";
import { t as modelCatalog } from "./openclaw.plugin-v5PRuifm.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
