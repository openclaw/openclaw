import { n as defineBundledChannelSetupEntry } from "../../channel-entry-contract-Dc3Ga3_x.js";
//#region extensions/nextcloud-talk/setup-entry.ts
var setup_entry_default = defineBundledChannelSetupEntry({
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./api.js",
		exportName: "nextcloudTalkPlugin"
	},
	secrets: {
		specifier: "./secret-contract-api.js",
		exportName: "channelSecrets"
	}
});
//#endregion
export { setup_entry_default as default };
