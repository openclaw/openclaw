import { t as definePluginEntry } from "../../plugin-entry-Db0KoQjL.js";
import { t as createSearxngWebSearchProvider } from "../../searxng-search-provider-DxbulwRf.js";
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
