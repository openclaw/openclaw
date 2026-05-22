import { h as extractPluginInstallRecordsFromInstalledPluginIndex, y as hashJson } from "./installed-plugin-index-store-DH9sPamj.js";
import { C as getPackageManifestMetadata, o as tracePluginLifecyclePhase, r as normalizePluginDependencySpecs, x as DEFAULT_PLUGIN_ENTRY_CANDIDATES } from "./discovery-CVL9-KJt.js";
import { t as loadPluginManifestRegistry } from "./manifest-registry-BiAsJcRZ.js";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/manifest-registry-installed.ts
function resolvePackageJsonPath(record) {
	if (!record.packageJson?.path) return;
	const rootDir = resolveInstalledPluginRootDir(record);
	const packageJsonPath = path.resolve(rootDir, record.packageJson.path);
	const relative = path.relative(rootDir, packageJsonPath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return;
	return packageJsonPath;
}
function safeFileSignature(filePath) {
	if (!filePath) return;
	try {
		const stat = fs.statSync(filePath);
		return `${filePath}:${stat.size}:${stat.mtimeMs}`;
	} catch {
		return `${filePath}:missing`;
	}
}
function buildInstalledManifestRegistryIndexKey(index) {
	return {
		version: index.version,
		hostContractVersion: index.hostContractVersion,
		compatRegistryVersion: index.compatRegistryVersion,
		migrationVersion: index.migrationVersion,
		policyHash: index.policyHash,
		installRecords: index.installRecords,
		diagnostics: index.diagnostics,
		plugins: index.plugins.map((record) => {
			const packageJsonPath = resolvePackageJsonPath(record);
			return {
				pluginId: record.pluginId,
				packageName: record.packageName,
				packageVersion: record.packageVersion,
				installRecord: record.installRecord,
				installRecordHash: record.installRecordHash,
				packageInstall: record.packageInstall,
				packageChannel: record.packageChannel,
				manifestPath: record.manifestPath,
				manifestHash: record.manifestHash,
				manifestFile: safeFileSignature(record.manifestPath),
				format: record.format,
				bundleFormat: record.bundleFormat,
				source: record.source,
				setupSource: record.setupSource,
				packageJson: record.packageJson,
				packageJsonFile: safeFileSignature(packageJsonPath),
				rootDir: record.rootDir,
				origin: record.origin,
				enabled: record.enabled,
				enabledByDefault: record.enabledByDefault,
				enabledByDefaultOnPlatforms: record.enabledByDefaultOnPlatforms ? [...record.enabledByDefaultOnPlatforms] : void 0,
				syntheticAuthRefs: record.syntheticAuthRefs,
				startup: record.startup,
				compat: record.compat
			};
		})
	};
}
function resolveInstalledManifestRegistryIndexFingerprint(index) {
	return hashJson(buildInstalledManifestRegistryIndexKey(index));
}
function resolveInstalledPluginRootDir(record) {
	return record.rootDir || path.dirname(record.manifestPath || process.cwd());
}
function resolveFallbackPluginSource(record) {
	const rootDir = resolveInstalledPluginRootDir(record);
	for (const entry of DEFAULT_PLUGIN_ENTRY_CANDIDATES) {
		const candidate = path.join(rootDir, entry);
		if (fs.existsSync(candidate)) return candidate;
	}
	return path.join(rootDir, DEFAULT_PLUGIN_ENTRY_CANDIDATES[0]);
}
function resolveInstalledPackageMetadata(record) {
	const fallbackPackageManifest = record.packageChannel ? { channel: record.packageChannel } : void 0;
	const rootDir = resolveInstalledPluginRootDir(record);
	const packageJsonPath = record.packageJson?.path ? path.resolve(rootDir, record.packageJson.path) : void 0;
	if (!packageJsonPath) return fallbackPackageManifest ? { packageManifest: fallbackPackageManifest } : {};
	const relative = path.relative(rootDir, packageJsonPath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return fallbackPackageManifest ? { packageManifest: fallbackPackageManifest } : {};
	try {
		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
		const packageManifest = getPackageManifestMetadata(packageJson);
		const dependencies = normalizePluginDependencySpecs({
			dependencies: packageJson.dependencies,
			optionalDependencies: packageJson.optionalDependencies
		});
		if (!packageManifest) return {
			...fallbackPackageManifest ? { packageManifest: fallbackPackageManifest } : {},
			packageDependencies: dependencies.dependencies,
			packageOptionalDependencies: dependencies.optionalDependencies
		};
		const channel = record.packageChannel || packageManifest.channel ? {
			...record.packageChannel,
			...packageManifest.channel
		} : void 0;
		return {
			packageManifest: {
				...packageManifest,
				...channel ? { channel } : {}
			},
			packageDependencies: dependencies.dependencies,
			packageOptionalDependencies: dependencies.optionalDependencies
		};
	} catch {
		return fallbackPackageManifest ? { packageManifest: fallbackPackageManifest } : {};
	}
}
function toPluginCandidate(record) {
	const rootDir = resolveInstalledPluginRootDir(record);
	const packageMetadata = resolveInstalledPackageMetadata(record);
	return {
		idHint: record.pluginId,
		source: record.source ?? resolveFallbackPluginSource(record),
		...record.setupSource ? { setupSource: record.setupSource } : {},
		rootDir,
		origin: record.origin,
		...record.format ? { format: record.format } : {},
		...record.bundleFormat ? { bundleFormat: record.bundleFormat } : {},
		...record.packageName ? { packageName: record.packageName } : {},
		...record.packageVersion ? { packageVersion: record.packageVersion } : {},
		...packageMetadata.packageManifest ? { packageManifest: packageMetadata.packageManifest } : {},
		...packageMetadata.packageDependencies ? { packageDependencies: packageMetadata.packageDependencies } : {},
		...packageMetadata.packageOptionalDependencies ? { packageOptionalDependencies: packageMetadata.packageOptionalDependencies } : {},
		packageDir: rootDir
	};
}
function loadPluginManifestRegistryForInstalledIndex(params) {
	return tracePluginLifecyclePhase("manifest registry", () => {
		if (params.pluginIds && params.pluginIds.length === 0) return {
			plugins: [],
			diagnostics: []
		};
		const env = params.env ?? process.env;
		const pluginIdSet = params.pluginIds?.length ? new Set(params.pluginIds) : null;
		const diagnostics = pluginIdSet ? params.index.diagnostics.filter((diagnostic) => {
			const pluginId = diagnostic.pluginId;
			return !pluginId || pluginIdSet.has(pluginId);
		}) : params.index.diagnostics;
		const candidates = params.index.plugins.filter((plugin) => params.includeDisabled || plugin.enabled).filter((plugin) => !pluginIdSet || pluginIdSet.has(plugin.pluginId)).map(toPluginCandidate);
		return loadPluginManifestRegistry({
			config: params.config,
			workspaceDir: params.workspaceDir,
			env,
			candidates,
			diagnostics: [...diagnostics],
			installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(params.index),
			...params.bundledChannelConfigCollector ? { bundledChannelConfigCollector: params.bundledChannelConfigCollector } : {}
		});
	}, {
		includeDisabled: params.includeDisabled === true,
		pluginIdCount: params.pluginIds?.length,
		indexPluginCount: params.index.plugins.length
	});
}
//#endregion
export { resolveInstalledManifestRegistryIndexFingerprint as n, loadPluginManifestRegistryForInstalledIndex as t };
