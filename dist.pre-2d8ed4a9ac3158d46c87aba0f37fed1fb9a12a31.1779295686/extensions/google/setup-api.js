import { t as definePluginEntry } from "../../plugin-entry-BW8FQC_w.js";
import { t as buildGoogleGeminiCliBackend } from "../../cli-backend-xaL2WJVn.js";
import { r as createGoogleVertexProvider } from "../../provider-contract-api-BodILz_x.js";
//#region extensions/google/setup-api.ts
var setup_api_default = definePluginEntry({
	id: "google",
	name: "Google Setup",
	description: "Lightweight Google setup hooks",
	register(api) {
		api.registerProvider(createGoogleVertexProvider());
		api.registerCliBackend(buildGoogleGeminiCliBackend());
	}
});
//#endregion
export { setup_api_default as default };
