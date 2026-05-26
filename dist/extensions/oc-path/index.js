import { t as definePluginEntry } from "../../plugin-entry-CJpThfKg.js";
import { t as registerOcPathCli } from "../../cli-registration-BAviOb1q.js";
//#region extensions/oc-path/index.ts
var oc_path_default = definePluginEntry({
	id: "oc-path",
	name: "OC Path",
	description: "Adds the openclaw path CLI for oc:// workspace file addressing.",
	register(api) {
		registerOcPathCli(api);
	}
});
//#endregion
export { oc_path_default as default };
