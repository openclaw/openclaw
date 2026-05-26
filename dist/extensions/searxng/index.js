import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { t as createSearxngWebSearchProvider } from "../../searxng-search-provider-Wl9cLPJr.js";
//#region extensions/searxng/index.ts
var searxng_default = definePluginEntry({
	id: "searxng",
	name: "SearXNG Plugin",
	description: "Bundled SearXNG web search plugin",
	register(api) {
		api.registerWebSearchProvider(createSearxngWebSearchProvider());
	}
});
//#endregion
export { searxng_default as default };
