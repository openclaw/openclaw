import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { l as tryReadJson, u as tryReadJsonSync } from "./json-files-CahFuwKs.js";
import { a as resolveDefaultPluginNpmDir, c as validatePluginId } from "./install-paths-COOYiHmY.js";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/installed-plugin-index-store-path.ts
const INSTALLED_PLUGIN_INDEX_STORE_PATH = path.join("plugins", "installs.json");
function resolveInstalledPluginIndexStorePath(options = {}) {
	if (options.filePath) return options.filePath;
	const env = options.env ?? process.env;
	const stateDir = options.stateDir ?? resolveStateDir(env);
	return path.join(stateDir, INSTALLED_PLUGIN_INDEX_STORE_PATH);
}
//#endregion
//#region src/plugins/installed-plugin-index-record-reader.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function cloneInstallRecords(records) {
	return structuredClone(records ?? {});
}
function readRecordMap(value) {
	if (!isRecord(value)) return null;
	const records = {};
	for (const [pluginId, record] of Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))) if (isRecord(record) && typeof record.source === "string") records[pluginId] = structuredClone(record);
	return records;
}
function readJsonObjectFileSync(filePath) {
	const parsed = tryReadJsonSync(filePath);
	return isRecord(parsed) ? parsed : null;
}
function readStringRecord(value) {
	if (!isRecord(value)) return {};
	const record = {};
	for (const [key, raw] of Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))) if (typeof raw === "string" && raw.trim()) record[key] = raw.trim();
	return record;
}
function hasPackagePluginMetadata(manifest) {
	const openclaw = manifest.openclaw;
	if (!isRecord(openclaw)) return false;
	const extensions = openclaw.extensions;
	return Array.isArray(extensions) && extensions.some((entry) => typeof entry === "string");
}
function readManifestPluginId(packageDir) {
	const manifest = readJsonObjectFileSync(path.join(packageDir, "openclaw.plugin.json"));
	return (typeof manifest?.id === "string" ? manifest.id.trim() : "") || void 0;
}
function resolveRecoveredManagedNpmPluginId(params) {
	const packageManifest = readJsonObjectFileSync(path.join(params.packageDir, "package.json"));
	if (!packageManifest || !hasPackagePluginMetadata(packageManifest)) return;
	const packageName = typeof packageManifest.name === "string" && packageManifest.name.trim() ? packageManifest.name.trim() : params.packageName;
	const pluginId = readManifestPluginId(params.packageDir) ?? packageName;
	return validatePluginId(pluginId) ? void 0 : pluginId;
}
function buildRecoveredManagedNpmInstallRecords(options = {}) {
	const npmRoot = options.stateDir ? path.join(options.stateDir, "npm") : resolveDefaultPluginNpmDir(options.env);
	const dependencies = readStringRecord(readJsonObjectFileSync(path.join(npmRoot, "package.json"))?.dependencies);
	const records = {};
	for (const [packageName, dependencySpec] of Object.entries(dependencies)) {
		const packageDir = path.join(npmRoot, "node_modules", packageName);
		let stat;
		try {
			stat = fs.statSync(packageDir);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;
		const pluginId = resolveRecoveredManagedNpmPluginId({
			packageName,
			packageDir
		});
		if (!pluginId) continue;
		const packageManifest = readJsonObjectFileSync(path.join(packageDir, "package.json"));
		const version = typeof packageManifest?.version === "string" && packageManifest.version.trim() ? packageManifest.version.trim() : void 0;
		records[pluginId] = {
			source: "npm",
			spec: `${packageName}@${dependencySpec}`,
			installPath: packageDir,
			...version ? {
				version,
				resolvedName: packageName,
				resolvedVersion: version
			} : {},
			...version ? { resolvedSpec: `${packageName}@${version}` } : {}
		};
	}
	return records;
}
function mergeRecoveredManagedNpmInstallRecords(persisted, options) {
	return {
		...buildRecoveredManagedNpmInstallRecords(options),
		...persisted
	};
}
function extractPluginInstallRecordsFromPersistedInstalledPluginIndex(index) {
	if (!isRecord(index)) return null;
	if (Object.prototype.hasOwnProperty.call(index, "installRecords")) return readRecordMap(index.installRecords) ?? {};
	if (!Array.isArray(index.plugins)) return null;
	const records = {};
	for (const entry of index.plugins) {
		if (!isRecord(entry) || typeof entry.pluginId !== "string" || !isRecord(entry.installRecord)) continue;
		records[entry.pluginId] = structuredClone(entry.installRecord);
	}
	return records;
}
async function readPersistedInstalledPluginIndexInstallRecords(options = {}) {
	return extractPluginInstallRecordsFromPersistedInstalledPluginIndex(await tryReadJson(resolveInstalledPluginIndexStorePath(options)));
}
function readPersistedInstalledPluginIndexInstallRecordsSync(options = {}) {
	return extractPluginInstallRecordsFromPersistedInstalledPluginIndex(tryReadJsonSync(resolveInstalledPluginIndexStorePath(options)));
}
async function loadInstalledPluginIndexInstallRecords(params = {}) {
	return cloneInstallRecords(mergeRecoveredManagedNpmInstallRecords(await readPersistedInstalledPluginIndexInstallRecords(params), params));
}
function loadInstalledPluginIndexInstallRecordsSync(params = {}) {
	return cloneInstallRecords(mergeRecoveredManagedNpmInstallRecords(readPersistedInstalledPluginIndexInstallRecordsSync(params), params));
}
//#endregion
export { resolveInstalledPluginIndexStorePath as a, readPersistedInstalledPluginIndexInstallRecordsSync as i, loadInstalledPluginIndexInstallRecordsSync as n, readPersistedInstalledPluginIndexInstallRecords as r, loadInstalledPluginIndexInstallRecords as t };
