import { n as defineBundledChannelSetupEntry } from "../../channel-entry-contract-BDMmGZzs.js";
//#region extensions/mattermost/setup-entry.ts
var setup_entry_default = defineBundledChannelSetupEntry({
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "mattermostSetupPlugin"
	},
	secrets: {
		specifier: "./secret-contract-api.js",
		exportName: "channelSecrets"
	}
});
//#endregion
export { setup_entry_default as default };
