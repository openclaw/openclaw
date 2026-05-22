import { t as definePluginEntry } from "../../plugin-entry-D9ROOnoR.js";
import { t as createSearxngWebSearchProvider } from "../../searxng-search-provider-op2q_vZ8.js";
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
