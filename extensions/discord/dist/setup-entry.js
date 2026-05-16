import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";
//#region extensions/discord/setup-entry.ts
var setup_entry_default = defineBundledChannelSetupEntry({
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./setup-plugin-api.js",
		exportName: "discordSetupPlugin"
	}
});
//#endregion
export { setup_entry_default as default };
