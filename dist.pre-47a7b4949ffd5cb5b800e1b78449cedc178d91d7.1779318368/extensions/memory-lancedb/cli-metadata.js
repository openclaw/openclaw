import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import "../../core-DihfuisK.js";
//#region extensions/memory-lancedb/cli-metadata.ts
var cli_metadata_default = definePluginEntry({
	id: "memory-lancedb",
	name: "Memory LanceDB",
	description: "LanceDB-backed memory provider",
	register(api) {
		api.registerCli(() => {}, { descriptors: [{
			name: "ltm",
			description: "Inspect and query LanceDB-backed memory",
			hasSubcommands: true
		}] });
	}
});
//#endregion
export { cli_metadata_default as default };
