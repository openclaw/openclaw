import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { a as resolveDefaultPluginNpmDir } from "./install-paths-B32RY-Gz.js";
import { f as loadInstalledPluginIndex } from "./installed-plugin-index-store-C1Oen9wR.js";
import { p as tryReadJsonSync } from "./json-files-C2hqjU--.js";
import { t as loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-record-reader-BvE-GqxR.js";
import { h as refreshPluginRegistry } from "./plugin-registry-CgH_ZSlH.js";
import { n as saveJsonFile } from "./json-file-DpLhTVdZ.js";
import "./installed-plugin-index-records-BrXfmg6n.js";
import { i as preflightPluginRegistryInstallMigration, r as migratePluginRegistryForInstall, t as DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV } from "./plugin-registry-migration-BUBnmpyz.js";
import { i as relinkOpenClawPeerDependenciesInManagedNpmRoot, t as auditOpenClawPeerDependenciesInManagedNpmRoot } from "./plugin-peer-link-Ckh-dj0J.js";
import { t as note } from "./note-Dg2Luaaq.js";
import { t as listStaleLocalBundledPluginInstallRecords } from "./stale-local-bundled-plugin-install-records-m13TpHTC.js";
import fs from "node:fs";
import path from "node:path";
//#region src/commands/doctor-plugin-registry.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readJsonObject(filePath) {
	const parsed = tryReadJsonSync(filePath);
	return isRecord(parsed) ? parsed : null;
}
function readStringMap(value) {
	if (!isRecord(value)) return {};
	const result = {};
	for (const [key, raw] of Object.entries(value)) if (typeof raw === "string" && raw.trim()) result[key] = raw.trim();
	return result;
}
function resolveManagedPluginNpmRoot(params) {
	return params.stateDir ? path.join(params.stateDir, "npm") : resolveDefaultPluginNpmDir(params.env);
}
function deleteObjectKey(record, key) {
	if (!Object.prototype.hasOwnProperty.call(record, key)) return false;
	delete record[key];
	return true;
}
function readPackageVersion(packageDir) {
	const version = readJsonObject(path.join(packageDir, "package.json"))?.version;
	return typeof version === "string" && version.trim() ? version.trim() : void 0;
}
function readPluginManifestId(packageDir) {
	const id = readJsonObject(path.join(packageDir, "openclaw.plugin.json"))?.id;
	return typeof id === "string" && id.trim() ? id.trim() : void 0;
}
function listStaleManagedNpmBundledPlugins(params) {
	const currentBundled = loadInstalledPluginIndex({
		...params,
		installRecords: {}
	}).plugins.filter((plugin) => plugin.origin === "bundled" && plugin.packageName);
	const bundledByPackage = new Map(currentBundled.map((plugin) => [plugin.packageName, plugin]));
	const npmRoot = resolveManagedPluginNpmRoot(params);
	const dependencies = readStringMap(readJsonObject(path.join(npmRoot, "package.json"))?.dependencies);
	const stale = [];
	for (const packageName of Object.keys(dependencies).toSorted((left, right) => left.localeCompare(right))) {
		if (!packageName.startsWith("@openclaw/")) continue;
		const bundled = bundledByPackage.get(packageName);
		if (!bundled) continue;
		const packageDir = path.join(npmRoot, "node_modules", packageName);
		const pluginId = readPluginManifestId(packageDir);
		if (!pluginId || pluginId !== bundled.pluginId) continue;
		stale.push({
			pluginId,
			packageName,
			packageDir,
			npmRoot,
			...readPackageVersion(packageDir) ? { version: readPackageVersion(packageDir) } : {}
		});
	}
	return stale;
}
function loadCurrentBundledPluginSources(params) {
	const currentBundled = loadInstalledPluginIndex({
		...params,
		installRecords: {}
	}).plugins.filter((plugin) => plugin.origin === "bundled");
	return new Map(currentBundled.map((plugin) => [plugin.pluginId, {
		pluginId: plugin.pluginId,
		localPath: plugin.rootDir,
		...plugin.packageName ? { npmSpec: plugin.packageName } : {},
		...plugin.packageVersion ? { version: plugin.packageVersion } : {}
	}]));
}
async function listStaleLocalBundledPluginInstallRecordShadows(params) {
	return listStaleLocalBundledPluginInstallRecords({
		installRecords: await loadInstalledPluginIndexInstallRecords(params),
		workspaceDir: params.workspaceDir,
		env: params.env,
		bundled: loadCurrentBundledPluginSources(params)
	});
}
function removeManagedNpmDependency(params) {
	const npmPackageJsonPath = path.join(params.npmRoot, "package.json");
	const packageJson = readJsonObject(npmPackageJsonPath) ?? {};
	const dependencies = readStringMap(packageJson.dependencies);
	delete dependencies[params.packageName];
	saveJsonFile(npmPackageJsonPath, Object.keys(dependencies).length === 0 ? (() => {
		const { dependencies: _dependencies, ...rest } = packageJson;
		return rest;
	})() : {
		...packageJson,
		dependencies
	});
	removeManagedNpmPackageLockDependency(params);
	fs.rmSync(params.packageDir, {
		recursive: true,
		force: true
	});
	const scopeDir = path.dirname(params.packageDir);
	if (path.basename(path.dirname(scopeDir)) === "node_modules") try {
		fs.rmdirSync(scopeDir);
	} catch {}
}
function removeManagedNpmPackageLockDependency(params) {
	const packageLockPath = path.join(params.npmRoot, "package-lock.json");
	const packageLock = readJsonObject(packageLockPath);
	if (!packageLock) return;
	let changed = false;
	const packages = packageLock.packages;
	if (isRecord(packages)) {
		const rootPackage = packages[""];
		if (isRecord(rootPackage)) {
			const rootDependencies = readStringMap(rootPackage.dependencies);
			if (deleteObjectKey(rootDependencies, params.packageName)) {
				changed = true;
				if (Object.keys(rootDependencies).length === 0) delete rootPackage.dependencies;
				else rootPackage.dependencies = rootDependencies;
			}
		}
		changed = deleteObjectKey(packages, `node_modules/${params.packageName}`) || changed;
	}
	const dependencies = packageLock.dependencies;
	if (isRecord(dependencies)) changed = deleteObjectKey(dependencies, params.packageName) || changed;
	if (changed) saveJsonFile(packageLockPath, packageLock);
}
function maybeRepairStaleManagedNpmBundledPlugins(params) {
	const stale = listStaleManagedNpmBundledPlugins(params);
	if (stale.length === 0) return false;
	if (!params.prompter.shouldRepair) {
		note([
			"Managed npm plugin packages shadow bundled plugins:",
			...stale.map((plugin) => `- ${plugin.pluginId}: ${plugin.packageName}${plugin.version ? `@${plugin.version}` : ""}`),
			`Repair with ${formatCliCommand("openclaw doctor --fix")} to remove stale managed npm packages and rebuild the plugin registry.`
		].join("\n"), "Plugin registry");
		return false;
	}
	for (const plugin of stale) removeManagedNpmDependency(plugin);
	note(["Removed stale managed npm plugin package(s) shadowing bundled plugins:", ...stale.map((plugin) => `- ${plugin.pluginId}: ${plugin.packageName}${plugin.version ? `@${plugin.version}` : ""}`)].join("\n"), "Plugin registry");
	return true;
}
async function maybeRepairStaleLocalBundledPluginInstallRecords(params) {
	const stale = await listStaleLocalBundledPluginInstallRecordShadows(params);
	if (stale.length === 0) return [];
	if (!params.prompter.shouldRepair) {
		note([
			"Local bundled plugin install records shadow bundled plugins:",
			...stale.map((record) => `- ${record.pluginId}: ${shortenHomePath(record.stalePath)}`),
			`Repair with ${formatCliCommand("openclaw doctor --fix")} to remove stale local install records and rebuild the plugin registry.`
		].join("\n"), "Plugin registry");
		return [];
	}
	note(["Removed stale local bundled plugin install record(s) shadowing bundled plugins:", ...stale.map((record) => `- ${record.pluginId}: ${shortenHomePath(record.stalePath)}`)].join("\n"), "Plugin registry");
	return stale.map((record) => record.pluginId);
}
async function maybeRepairManagedNpmOpenClawPeerLinks(params) {
	const npmRoot = resolveManagedPluginNpmRoot(params);
	if (!params.prompter.shouldRepair) {
		const audit = await auditOpenClawPeerDependenciesInManagedNpmRoot({ npmRoot });
		if (audit.broken > 0) note([
			"Managed npm OpenClaw host peer links need repair:",
			...audit.issues.map((issue) => `- ${issue.packageName}: ${issue.reason}`),
			`Repair with ${formatCliCommand("openclaw doctor --fix")} to relink managed npm plugin packages.`
		].join("\n"), "Plugin registry");
		return false;
	}
	const messages = [];
	const result = await relinkOpenClawPeerDependenciesInManagedNpmRoot({
		npmRoot,
		logger: {
			info: (message) => messages.push({
				level: "info",
				message
			}),
			warn: (message) => messages.push({
				level: "warn",
				message
			})
		}
	});
	if (result.repaired > 0) note(`Repaired OpenClaw host peer link(s) for ${result.repaired} managed npm plugin package(s).`, "Plugin registry");
	const warnings = messages.filter((message) => message.level === "warn").map((message) => `- ${message.message}`);
	if (warnings.length > 0) note(["Could not repair all managed npm OpenClaw host peer links:", ...warnings].join("\n"), "Plugin registry");
	return result.repaired > 0;
}
async function loadInstallRecordsWithoutPluginIds(params, pluginIds) {
	const records = await loadInstalledPluginIndexInstallRecords(params);
	for (const pluginId of pluginIds) delete records[pluginId];
	return records;
}
async function maybeRepairPluginRegistryState(params) {
	const preflight = preflightPluginRegistryInstallMigration(params);
	for (const warning of preflight.deprecationWarnings) note(warning, "Plugin registry");
	if (preflight.action === "disabled") {
		note(`${DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV} is set; skipping plugin registry repair.`, "Plugin registry");
		return params.config;
	}
	const migrationParams = {
		...params,
		config: params.config
	};
	const staleManagedNpmBundledPluginIds = listStaleManagedNpmBundledPlugins(params).map((plugin) => plugin.pluginId);
	const removedStaleManagedNpmBundledPlugins = maybeRepairStaleManagedNpmBundledPlugins(params);
	const removedStaleLocalBundledPluginIds = await maybeRepairStaleLocalBundledPluginInstallRecords(params);
	const repairedManagedNpmOpenClawPeerLinks = await maybeRepairManagedNpmOpenClawPeerLinks(params);
	const stalePluginIdsToRemove = [...new Set([...removedStaleManagedNpmBundledPlugins ? staleManagedNpmBundledPluginIds : [], ...removedStaleLocalBundledPluginIds])];
	if (!params.prompter.shouldRepair) {
		if (preflight.action === "migrate") note(["Persisted plugin registry is missing or stale.", `Repair with ${formatCliCommand("openclaw doctor --fix")} to rebuild ${shortenHomePath(preflight.filePath)} from enabled plugins.`].join("\n"), "Plugin registry");
		return params.config;
	}
	if (preflight.action === "migrate") {
		const result = await migratePluginRegistryForInstall({
			...migrationParams,
			...stalePluginIdsToRemove.length > 0 ? { installRecords: await loadInstallRecordsWithoutPluginIds(params, stalePluginIdsToRemove) } : {}
		});
		if (result.migrated) {
			const total = result.current.plugins.length;
			const enabled = result.current.plugins.filter((plugin) => plugin.enabled).length;
			note(`Plugin registry rebuilt: ${enabled}/${total} enabled plugins indexed.`, "Plugin registry");
		}
		return params.config;
	}
	if (preflight.action === "skip-existing" || removedStaleManagedNpmBundledPlugins || removedStaleLocalBundledPluginIds.length > 0 || repairedManagedNpmOpenClawPeerLinks) {
		const index = await refreshPluginRegistry({
			...migrationParams,
			reason: "migration",
			...stalePluginIdsToRemove.length > 0 ? { installRecords: await loadInstallRecordsWithoutPluginIds(params, stalePluginIdsToRemove) } : {}
		});
		const total = index.plugins.length;
		const enabled = index.plugins.filter((plugin) => plugin.enabled).length;
		note(`Plugin registry refreshed: ${enabled}/${total} enabled plugins indexed.`, "Plugin registry");
	}
	return params.config;
}
//#endregion
export { maybeRepairStaleManagedNpmBundledPlugins as i, maybeRepairPluginRegistryState as n, maybeRepairStaleLocalBundledPluginInstallRecords as r, maybeRepairManagedNpmOpenClawPeerLinks as t };
