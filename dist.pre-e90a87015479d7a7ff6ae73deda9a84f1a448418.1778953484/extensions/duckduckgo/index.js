import { t as definePluginEntry } from "../../plugin-entry-Cq3HIsoQ.js";
import { t as createDuckDuckGoWebSearchProvider } from "../../ddg-search-provider-xg6IGEU6.js";
//#region extensions/duckduckgo/index.ts
var duckduckgo_default = definePluginEntry({
	id: "duckduckgo",
	name: "DuckDuckGo Plugin",
	description: "Bundled DuckDuckGo web search plugin",
	register(api) {
		api.registerWebSearchProvider(createDuckDuckGoWebSearchProvider());
	}
});
//#endregion
export { duckduckgo_default as default };
