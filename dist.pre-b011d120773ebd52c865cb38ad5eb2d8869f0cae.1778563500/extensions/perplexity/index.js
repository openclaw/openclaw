import { t as definePluginEntry } from "../../plugin-entry-6pkoHhQg.js";
import { t as createPerplexityWebSearchProvider } from "../../perplexity-web-search-provider-Y4uCHs1o.js";
//#region extensions/perplexity/index.ts
var perplexity_default = definePluginEntry({
	id: "perplexity",
	name: "Perplexity Plugin",
	description: "Bundled Perplexity plugin",
	register(api) {
		api.registerWebSearchProvider(createPerplexityWebSearchProvider());
	}
});
//#endregion
export { perplexity_default as default };
