import { n as defineBundledChannelSetupEntry } from "../../channel-entry-contract-DJgUK72T.js";
//#region extensions/nostr/setup-entry.ts
var setup_entry_default = defineBundledChannelSetupEntry({
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./setup-plugin-api.js",
		exportName: "nostrSetupPlugin"
	}
});
//#endregion
export { setup_entry_default as default };
