import { Nn as record, Rn as string, Tn as object } from "./schemas-Del5uzR8.js";
import { n as PluginInstallRecordShape } from "./zod-schema.installs-D7BhBdmh.js";
//#region src/config/plugin-install-config-migration.ts
const PluginInstallRecordsSchema = record(string(), object(PluginInstallRecordShape).passthrough());
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function pruneEmptyPluginsObject(plugins) {
	const { installs: _installs, ...rest } = plugins;
	return Object.keys(rest).length === 0 ? void 0 : rest;
}
function extractShippedPluginInstallConfigRecords(config) {
	if (!isRecord(config) || !isRecord(config.plugins)) return {};
	const parsed = PluginInstallRecordsSchema.safeParse(config.plugins.installs);
	return parsed.success ? structuredClone(parsed.data) : {};
}
function stripShippedPluginInstallConfigRecords(config) {
	if (!isRecord(config) || !isRecord(config.plugins) || !("installs" in config.plugins)) return config;
	const plugins = pruneEmptyPluginsObject(config.plugins);
	const { plugins: _plugins, ...rest } = config;
	return plugins === void 0 ? rest : {
		...rest,
		plugins
	};
}
//#endregion
export { stripShippedPluginInstallConfigRecords as n, extractShippedPluginInstallConfigRecords as t };
