import { t as defineBundledChannelEntry } from "../../channel-entry-contract-CKBbKBsj.js";
//#region extensions/tlon/index.ts
var tlon_default = defineBundledChannelEntry({
	id: "tlon",
	name: "Tlon",
	description: "Tlon/Urbit channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "tlonPlugin"
	},
	runtime: {
		specifier: "./api.js",
		exportName: "setTlonRuntime"
	}
});
//#endregion
export { tlon_default as default };
