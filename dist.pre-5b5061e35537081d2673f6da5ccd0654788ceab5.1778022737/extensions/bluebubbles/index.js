import { t as defineBundledChannelEntry } from "../../channel-entry-contract-CSjRAxu4.js";
//#region extensions/bluebubbles/index.ts
var bluebubbles_default = defineBundledChannelEntry({
	id: "bluebubbles",
	name: "BlueBubbles",
	description: "BlueBubbles channel plugin (macOS app)",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "bluebubblesPlugin"
	},
	secrets: {
		specifier: "./secret-contract-api.js",
		exportName: "channelSecrets"
	},
	runtime: {
		specifier: "./runtime-api.js",
		exportName: "setBlueBubblesRuntime"
	}
});
//#endregion
export { bluebubbles_default as default };
