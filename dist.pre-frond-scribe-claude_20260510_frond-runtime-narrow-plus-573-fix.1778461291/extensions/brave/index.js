import { t as definePluginEntry } from "../../plugin-entry-Db0KoQjL.js";
import { t as createBraveWebSearchProvider } from "../../brave-web-search-provider-CrXqVsuE.js";
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
