import { t as defineBundledChannelEntry } from "../../channel-entry-contract-u2Swc40a.js";
import { t as registerDiscordSubagentHooks } from "../../subagent-hooks-api-BU6qOfDo.js";
//#region extensions/discord/index.ts
var discord_default = defineBundledChannelEntry({
	id: "discord",
	name: "Discord",
	description: "Discord channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "discordPlugin"
	},
	runtime: {
		specifier: "./runtime-setter-api.js",
		exportName: "setDiscordRuntime"
	},
	accountInspect: {
		specifier: "./account-inspect-api.js",
		exportName: "inspectDiscordReadOnlyAccount"
	},
	registerFull(api) {
		registerDiscordSubagentHooks(api);
	}
});
//#endregion
export { discord_default as default };
