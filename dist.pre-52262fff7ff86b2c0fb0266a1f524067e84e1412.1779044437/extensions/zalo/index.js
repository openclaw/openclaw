import { t as defineBundledChannelEntry } from "../../channel-entry-contract-CbDI8fEX.js";
//#region extensions/zalo/index.ts
var zalo_default = defineBundledChannelEntry({
	id: "zalo",
	name: "Zalo",
	description: "Zalo channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "zaloPlugin"
	},
	secrets: {
		specifier: "./secret-contract-api.js",
		exportName: "channelSecrets"
	},
	runtime: {
		specifier: "./runtime-api.js",
		exportName: "setZaloRuntime"
	}
});
//#endregion
export { zalo_default as default };
