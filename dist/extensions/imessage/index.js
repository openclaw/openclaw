import { t as defineBundledChannelEntry } from "../../channel-entry-contract-BDMmGZzs.js";
//#region extensions/imessage/index.ts
var imessage_default = defineBundledChannelEntry({
	id: "imessage",
	name: "iMessage",
	description: "iMessage channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "imessagePlugin"
	},
	runtime: {
		specifier: "./runtime-api.js",
		exportName: "setIMessageRuntime"
	}
});
//#endregion
export { imessage_default as default };
