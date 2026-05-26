import { t as defineBundledChannelEntry } from "../../channel-entry-contract-DGmOIqjJ.js";
//#region extensions/signal/channel-entry.ts
var channel_entry_default = defineBundledChannelEntry({
	id: "signal",
	name: "Signal",
	description: "Signal channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./api.js",
		exportName: "signalPlugin"
	},
	runtime: {
		specifier: "./runtime-api.js",
		exportName: "setSignalRuntime"
	}
});
//#endregion
export { channel_entry_default as default };
