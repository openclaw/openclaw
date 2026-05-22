import { n as defineBundledChannelSetupEntry } from "../../channel-entry-contract-CRTBBsEQ.js";
//#region extensions/line/setup-entry.ts
var setup_entry_default = defineBundledChannelSetupEntry({
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./api.js",
		exportName: "lineSetupPlugin"
	}
});
//#endregion
export { setup_entry_default as default };
