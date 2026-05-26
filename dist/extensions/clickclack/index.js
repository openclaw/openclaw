import { t as defineBundledChannelEntry } from "../../channel-entry-contract-BDMmGZzs.js";
//#region extensions/clickclack/index.ts
var clickclack_default = defineBundledChannelEntry({
	id: "clickclack",
	name: "ClickClack",
	description: "ClickClack channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "clickClackPlugin"
	},
	runtime: {
		specifier: "./api.js",
		exportName: "setClickClackRuntime"
	}
});
//#endregion
export { clickclack_default as default };
