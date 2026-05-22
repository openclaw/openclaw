import { t as definePluginEntry } from "../../plugin-entry-SrJZmI2E.js";
import { t as createBraveWebSearchProvider } from "../../brave-web-search-provider-nZuH0C3h.js";
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
