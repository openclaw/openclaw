import { n as defineBundledChannelSetupEntry } from "../../channel-entry-contract-DNXxsJbf.js";
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
