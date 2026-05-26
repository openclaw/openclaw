import { t as defineBundledChannelEntry } from "../../channel-entry-contract-BDMmGZzs.js";
//#region extensions/irc/index.ts
var irc_default = defineBundledChannelEntry({
	id: "irc",
	name: "IRC",
	description: "IRC channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "ircPlugin"
	},
	secrets: {
		specifier: "./secret-contract-api.js",
		exportName: "channelSecrets"
	},
	runtime: {
		specifier: "./runtime-api.js",
		exportName: "setIrcRuntime"
	}
});
//#endregion
export { irc_default as default };
