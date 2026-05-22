import { t as defineBundledChannelEntry } from "../../channel-entry-contract-DMxH4te6.js";
//#region extensions/googlechat/index.ts
var googlechat_default = defineBundledChannelEntry({
	id: "googlechat",
	name: "Google Chat",
	description: "OpenClaw Google Chat channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "googlechatPlugin"
	},
	secrets: {
		specifier: "./secret-contract-api.js",
		exportName: "channelSecrets"
	},
	runtime: {
		specifier: "./runtime-api.js",
		exportName: "setGoogleChatRuntime"
	}
});
//#endregion
export { googlechat_default as default };
