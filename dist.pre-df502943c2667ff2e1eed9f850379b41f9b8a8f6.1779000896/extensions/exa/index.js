import { t as definePluginEntry } from "../../plugin-entry-qhhTPsFQ.js";
import { t as createExaWebSearchProvider } from "../../exa-web-search-provider-DV9H8dY9.js";
//#region extensions/exa/index.ts
var exa_default = definePluginEntry({
	id: "exa",
	name: "Exa Plugin",
	description: "Bundled Exa web search plugin",
	register(api) {
		api.registerWebSearchProvider(createExaWebSearchProvider());
	}
});
//#endregion
export { exa_default as default };
