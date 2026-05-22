import { n as defineBundledChannelSetupEntry } from "../../channel-entry-contract-BbQd7eJX.js";
//#region extensions/synology-chat/setup-entry.ts
var setup_entry_default = defineBundledChannelSetupEntry({
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./api.js",
		exportName: "synologyChatPlugin"
	}
});
//#endregion
export { setup_entry_default as default };
