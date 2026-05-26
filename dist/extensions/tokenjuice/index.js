import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { t as createTokenjuiceAgentToolResultMiddleware } from "../../tool-result-middleware-CIKwEDyc.js";
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
