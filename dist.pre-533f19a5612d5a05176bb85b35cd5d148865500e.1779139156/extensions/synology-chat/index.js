import { t as defineBundledChannelEntry } from "../../channel-entry-contract-DH7oXv7Q.js";
//#region extensions/synology-chat/index.ts
var synology_chat_default = defineBundledChannelEntry({
	id: "synology-chat",
	name: "Synology Chat",
	description: "Native Synology Chat channel plugin for OpenClaw",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "synologyChatPlugin"
	},
	runtime: {
		specifier: "./api.js",
		exportName: "setSynologyRuntime"
	}
});
//#endregion
export { synology_chat_default as default };
