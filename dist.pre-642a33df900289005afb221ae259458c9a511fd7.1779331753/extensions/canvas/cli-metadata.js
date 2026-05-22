import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
//#region extensions/canvas/cli-metadata.ts
var cli_metadata_default = definePluginEntry({
	id: "canvas",
	name: "Canvas",
	description: "Experimental Canvas control and A2UI rendering surfaces for paired nodes.",
	register(api) {
		api.registerNodeCliFeature(() => {}, { descriptors: [{
			name: "canvas",
			description: "Capture or render canvas content from a paired node",
			hasSubcommands: true
		}] });
	}
});
//#endregion
export { cli_metadata_default as default };
