import { t as defineBundledChannelEntry } from "../../channel-entry-contract-DNXxsJbf.js";
//#region extensions/feishu/channel-entry.ts
var channel_entry_default = defineBundledChannelEntry({
	id: "feishu",
	name: "Feishu",
	description: "Feishu/Lark channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./api.js",
		exportName: "feishuPlugin"
	},
	secrets: {
		specifier: "./secret-contract-api.js",
		exportName: "channelSecrets"
	},
	runtime: {
		specifier: "./runtime-api.js",
		exportName: "setFeishuRuntime"
	}
});
//#endregion
export { channel_entry_default as default };
