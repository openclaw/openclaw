import { t as definePluginEntry } from "../../plugin-entry-BWGTdHUK.js";
import { t as createBraveWebSearchProvider } from "../../brave-web-search-provider-7f7B5cNZ.js";
//#region extensions/brave/index.ts
var brave_default = definePluginEntry({
	id: "brave",
	name: "Brave Plugin",
	description: "Bundled Brave plugin",
	register(api) {
		api.registerWebSearchProvider(createBraveWebSearchProvider());
	}
});
//#endregion
export { brave_default as default };
