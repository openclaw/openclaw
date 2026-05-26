import { n as mergePluginTextTransforms } from "./plugin-text-transforms-jHXsIkoa.js";
import { t as getActiveRuntimePluginRegistry } from "./active-runtime-registry-wEpAEHY2.js";
//#region src/plugins/text-transforms.runtime.ts
function resolveRuntimeTextTransforms() {
	const registry = getActiveRuntimePluginRegistry();
	return mergePluginTextTransforms(...Array.isArray(registry?.textTransforms) ? registry.textTransforms.map((entry) => entry.transforms) : []);
}
//#endregion
export { resolveRuntimeTextTransforms as t };
