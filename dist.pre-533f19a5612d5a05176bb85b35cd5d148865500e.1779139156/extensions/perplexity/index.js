import { t as definePluginEntry } from "../../plugin-entry-DPwMZz_-.js";
import { t as createPerplexityWebSearchProvider } from "../../perplexity-web-search-provider-Bkk9MMvU.js";
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
