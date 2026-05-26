import { c as isRecord } from "../../utils-sBTEdeml.js";
import "../../string-coerce-runtime-BAEEbdFW.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
//#region extensions/canvas/src/config-migration.ts
function readRecord(value) {
	return isRecord(value) ? value : void 0;
}
function mergeHostConfig(params) {
	return Object.assign({}, params.legacyHost, params.existingHost);
}
function migrateLegacyCanvasHostConfig(config) {
	const legacyHost = readRecord(config.canvasHost);
	if (!legacyHost) return null;
	const plugins = structuredClone(readRecord(config.plugins) ?? {});
	const entries = readRecord(plugins.entries) ?? {};
	const canvasEntry = readRecord(entries.canvas) ?? {};
	const canvasConfig = readRecord(canvasEntry.config) ?? {};
	const existingHost = readRecord(canvasConfig.host);
	entries.canvas = {
		...canvasEntry,
		config: {
			...canvasConfig,
			host: mergeHostConfig({
				legacyHost,
				existingHost
			})
		}
	};
	plugins.entries = entries;
	const next = {
		...config,
		plugins
	};
	delete next.canvasHost;
	return {
		config: next,
		changes: ["migrated canvasHost to plugins.entries.canvas.config.host"]
	};
}
//#endregion
//#region extensions/canvas/setup-api.ts
var setup_api_default = definePluginEntry({
	id: "canvas",
	name: "Canvas Setup",
	description: "Lightweight Canvas setup hooks",
	register(api) {
		api.registerConfigMigration((config) => migrateLegacyCanvasHostConfig(config));
	}
});
//#endregion
export { setup_api_default as default };
