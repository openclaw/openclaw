import { n as defineBundledChannelSetupEntry } from "../../channel-entry-contract-DJgUK72T.js";
//#region extensions/feishu/setup-entry.ts
var setup_entry_default = defineBundledChannelSetupEntry({
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./setup-api.js",
		exportName: "feishuPlugin"
	},
	secrets: {
		specifier: "./secret-contract-api.js",
		exportName: "channelSecrets"
	}
});
//#endregion
export { setup_entry_default as default };
