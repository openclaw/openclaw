import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { t as registerOcPathCli } from "../../cli-registration-BPxgdYEv.js";
//#region extensions/oc-path/cli-metadata.ts
var cli_metadata_default = definePluginEntry({
	id: "oc-path",
	name: "OC Path",
	description: "Adds the openclaw path CLI for oc:// workspace file addressing.",
	register(api) {
		registerOcPathCli(api);
	}
});
//#endregion
export { cli_metadata_default as default };
