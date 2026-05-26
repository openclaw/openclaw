import { a as refreshPersistedInstalledPluginIndexSync, i as refreshPersistedInstalledPluginIndex } from "./installed-plugin-index-store-C1Oen9wR.js";
import { a as resolveInstalledPluginIndexStorePath } from "./installed-plugin-index-record-reader-BvE-GqxR.js";
import { n as recordPluginInstall } from "./installs-j3Id-apF.js";
//#region src/plugins/installed-plugin-index-records.ts
const PLUGIN_INSTALLS_CONFIG_PATH = ["plugins", "installs"];
function resolveInstalledPluginIndexRecordsStorePath(options = {}) {
	return resolveInstalledPluginIndexStorePath(options);
}
async function writePersistedInstalledPluginIndexInstallRecords(records, options = {}) {
	await refreshPersistedInstalledPluginIndex({
		...options,
		reason: "source-changed",
		installRecords: records
	});
	return resolveInstalledPluginIndexRecordsStorePath(options);
}
function writePersistedInstalledPluginIndexInstallRecordsSync(records, options = {}) {
	refreshPersistedInstalledPluginIndexSync({
		...options,
		reason: "source-changed",
		installRecords: records
	});
	return resolveInstalledPluginIndexRecordsStorePath(options);
}
function withPluginInstallRecords(config, records) {
	return {
		...config,
		plugins: {
			...config.plugins,
			installs: records
		}
	};
}
function withoutPluginInstallRecords(config) {
	if (!config.plugins?.installs) return config;
	const { installs: _installs, ...plugins } = config.plugins;
	if (Object.keys(plugins).length === 0) {
		const { plugins: _plugins, ...rest } = config;
		return rest;
	}
	return {
		...config,
		plugins
	};
}
function recordPluginInstallInRecords(records, update) {
	return recordPluginInstall({ plugins: { installs: records } }, update).plugins?.installs ?? {};
}
function removePluginInstallRecordFromRecords(records, pluginId) {
	const { [pluginId]: _removed, ...rest } = records;
	return rest;
}
//#endregion
export { withPluginInstallRecords as a, writePersistedInstalledPluginIndexInstallRecordsSync as c, resolveInstalledPluginIndexRecordsStorePath as i, recordPluginInstallInRecords as n, withoutPluginInstallRecords as o, removePluginInstallRecordFromRecords as r, writePersistedInstalledPluginIndexInstallRecords as s, PLUGIN_INSTALLS_CONFIG_PATH as t };
