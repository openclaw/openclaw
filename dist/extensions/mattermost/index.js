import { r as loadBundledEntryExportSync, t as defineBundledChannelEntry } from "../../channel-entry-contract-BDMmGZzs.js";
//#region extensions/mattermost/index.ts
function registerSlashCommandRoute(api) {
	loadBundledEntryExportSync(import.meta.url, {
		specifier: "./slash-route-api.js",
		exportName: "registerSlashCommandRoute"
	})(api);
}
var mattermost_default = defineBundledChannelEntry({
	id: "mattermost",
	name: "Mattermost",
	description: "Mattermost channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "mattermostPlugin"
	},
	secrets: {
		specifier: "./secret-contract-api.js",
		exportName: "channelSecrets"
	},
	runtime: {
		specifier: "./runtime-api.js",
		exportName: "setMattermostRuntime"
	},
	registerFull(api) {
		registerSlashCommandRoute(api);
	}
});
//#endregion
export { mattermost_default as default };
