import { n as defineBundledChannelSetupEntry } from "../../channel-entry-contract-BjGhklLB.js";
//#region extensions/tlon/setup-entry.ts
var setup_entry_default = defineBundledChannelSetupEntry({
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./api.js",
		exportName: "tlonPlugin"
	}
});
//#endregion
export { setup_entry_default as default };
