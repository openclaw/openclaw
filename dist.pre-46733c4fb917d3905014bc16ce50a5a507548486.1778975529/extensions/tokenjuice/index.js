import { t as definePluginEntry } from "../../plugin-entry-D9ROOnoR.js";
import { t as createTokenjuiceAgentToolResultMiddleware } from "../../tool-result-middleware-B5S_Wki2.js";
//#region extensions/tokenjuice/index.ts
var tokenjuice_default = definePluginEntry({
	id: "tokenjuice",
	name: "tokenjuice",
	description: "Compacts exec and bash tool results with tokenjuice reducers.",
	register(api) {
		api.registerAgentToolResultMiddleware(createTokenjuiceAgentToolResultMiddleware(), { runtimes: ["pi", "codex"] });
	}
});
//#endregion
export { tokenjuice_default as default };
