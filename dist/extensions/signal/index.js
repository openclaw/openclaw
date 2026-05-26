import { t as defineBundledChannelEntry } from "../../channel-entry-contract-BDMmGZzs.js";
//#region extensions/signal/index.ts
var signal_default = defineBundledChannelEntry({
	id: "signal",
	name: "Signal",
	description: "Signal channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "signalPlugin"
	},
	runtime: {
		specifier: "./runtime-api.js",
		exportName: "setSignalRuntime"
	}
});
//#endregion
export { signal_default as default };
