import { t as defineBundledChannelEntry } from "../../channel-entry-contract-CJpktzuf.js";
//#region extensions/slack/channel-entry.ts
var channel_entry_default = defineBundledChannelEntry({
	id: "slack",
	name: "Slack",
	description: "Slack channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./api.js",
		exportName: "slackPlugin"
	},
	secrets: {
		specifier: "./secret-contract-api.js",
		exportName: "channelSecrets"
	},
	runtime: {
		specifier: "./runtime-setter-api.js",
		exportName: "setSlackRuntime"
	}
});
//#endregion
export { channel_entry_default as default };
