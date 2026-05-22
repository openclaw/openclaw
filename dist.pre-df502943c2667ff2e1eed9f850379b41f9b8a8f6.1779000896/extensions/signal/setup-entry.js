import { n as defineBundledChannelSetupEntry } from "../../channel-entry-contract-DNXxsJbf.js";
//#region extensions/signal/setup-entry.ts
var setup_entry_default = defineBundledChannelSetupEntry({
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./api.js",
		exportName: "signalSetupPlugin"
	}
});
//#endregion
export { setup_entry_default as default };
