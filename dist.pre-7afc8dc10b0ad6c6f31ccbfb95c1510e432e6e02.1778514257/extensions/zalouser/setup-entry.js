import { n as defineBundledChannelSetupEntry } from "../../channel-entry-contract-CJpktzuf.js";
//#region extensions/zalouser/setup-entry.ts
var setup_entry_default = defineBundledChannelSetupEntry({
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./setup-plugin-api.js",
		exportName: "zalouserSetupPlugin"
	}
});
//#endregion
export { setup_entry_default as default };
