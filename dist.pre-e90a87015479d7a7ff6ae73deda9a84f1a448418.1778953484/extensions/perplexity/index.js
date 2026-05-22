import { t as definePluginEntry } from "../../plugin-entry-Cq3HIsoQ.js";
import { t as createPerplexityWebSearchProvider } from "../../perplexity-web-search-provider-5hxC5AZG.js";
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
