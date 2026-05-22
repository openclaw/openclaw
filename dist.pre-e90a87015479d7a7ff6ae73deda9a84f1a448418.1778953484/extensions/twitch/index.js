import { t as defineBundledChannelEntry } from "../../channel-entry-contract-CKBbKBsj.js";
//#region extensions/twitch/index.ts
var twitch_default = defineBundledChannelEntry({
	id: "twitch",
	name: "Twitch",
	description: "Twitch IRC chat channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "twitchPlugin"
	},
	runtime: {
		specifier: "./api.js",
		exportName: "setTwitchRuntime"
	}
});
//#endregion
export { twitch_default as default };
