import { _ as resolveInstalledPluginIndexPolicyHash, d as isInstalledPluginEnabled, f as loadInstalledPluginIndex, h as extractPluginInstallRecordsFromInstalledPluginIndex, i as refreshPersistedInstalledPluginIndex, m as hasOptionalMissingPluginManifestFile, r as readPersistedInstalledPluginIndexSync, t as inspectPersistedInstalledPluginIndex, u as getInstalledPluginRecord, v as fileSignatureMatches } from "./installed-plugin-index-store-DH9sPamj.js";
import { i as normalizePluginsConfigWithResolver } from "./config-normalization-shared-DamsNnJD.js";
import { n as resolveBundledPluginsDir } from "./bundled-dir-DL2yDGTU.js";
import { s as loadInstalledPluginIndexInstallRecordsSync } from "./manifest-registry-BiAsJcRZ.js";
import { t as loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed-5Jxol4QJ.js";
import { r as normalizeProviderId } from "./provider-id-DIRgKpoh.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
//#region src/plugins/plugin-registry-id-normalizer.ts
function normalizePluginRegistryAlias(value) {
	return value.trim();
}
function normalizePluginRegistryAliasKey(value) {
	return normalizePluginRegistryAlias(value).toLowerCase();
}
function collectObjectKeys$1(value) {
	return value ? Object.keys(value) : [];
}
function listPluginRegistryNormalizerAliases(plugin) {
	return [
		plugin.id,
		...plugin.providers ?? [],
		...plugin.channels ?? [],
		...plugin.setup?.providers?.map((provider) => provider.id) ?? [],
		...plugin.cliBackends ?? [],
		...plugin.setup?.cliBackends ?? [],
		...collectObjectKeys$1(plugin.modelCatalog?.providers),
		...collectObjectKeys$1(plugin.modelCatalog?.aliases),
		...plugin.legacyPluginIds ?? []
	];
}
function createPluginRegistryIdNormalizer(index, options = {}) {
	const aliases = /* @__PURE__ */ new Map();
	for (const plugin of index.plugins) {
		if (!plugin.pluginId) continue;
		const pluginId = normalizePluginRegistryAlias(plugin.pluginId);
		if (pluginId) aliases.set(normalizePluginRegistryAliasKey(pluginId), plugin.pluginId);
	}
	const registry = options.lookUpTable?.manifestRegistry ?? options.manifestRegistry ?? loadPluginManifestRegistryForInstalledIndex({
		index,
		includeDisabled: true
	});
	for (const plugin of [...registry.plugins].toSorted((left, right) => left.id.localeCompare(right.id))) {
		const pluginId = normalizePluginRegistryAlias(plugin.id);
		if (!pluginId) continue;
		aliases.set(normalizePluginRegistryAliasKey(pluginId), plugin.id);
		for (const alias of listPluginRegistryNormalizerAliases(plugin)) {
			const normalizedAlias = normalizePluginRegistryAlias(alias);
			const normalizedAliasKey = normalizePluginRegistryAliasKey(alias);
			if (normalizedAlias && !aliases.has(normalizedAliasKey)) aliases.set(normalizedAliasKey, pluginId);
		}
	}
	return (pluginId) => {
		const trimmed = normalizePluginRegistryAlias(pluginId);
		return aliases.get(normalizePluginRegistryAliasKey(trimmed)) ?? trimmed;
	};
}
//#endregion
//#region src/plugins/plugin-registry-snapshot.ts
const DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV = "OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY";
function formatDeprecatedPersistedRegistryDisableWarning() {
	return `${DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV} is a deprecated break-glass compatibility switch; use \`openclaw plugins registry --refresh\` or \`openclaw doctor --fix\` to repair registry state.`;
}
function hasEnvFlag(env, name) {
	const value = env[name]?.trim().toLowerCase();
	return Boolean(value && value !== "0" && value !== "false" && value !== "no");
}
function hasMissingPersistedPluginSource(index) {
	return index.plugins.some((plugin) => {
		if (!plugin.enabled) return false;
		return !fs.existsSync(plugin.rootDir) || !hasOptionalMissingPluginManifestFile(plugin) && !fs.existsSync(plugin.manifestPath) || (plugin.source ? !fs.existsSync(plugin.source) : false) || (plugin.setupSource ? !fs.existsSync(plugin.setupSource) : false);
	});
}
function resolveComparablePath(filePath) {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return path.resolve(filePath);
	}
}
function isPathInsideOrEqual(childPath, parentPath) {
	const relative = path.relative(resolveComparablePath(parentPath), resolveComparablePath(childPath));
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function hasMismatchedPersistedBundledPluginRoot(index, env) {
	const bundledPluginsDir = resolveBundledPluginsDir(env);
	if (!bundledPluginsDir) return false;
	return index.plugins.some((plugin) => plugin.origin === "bundled" && !isPathInsideOrEqual(plugin.rootDir, bundledPluginsDir));
}
function hashExistingFile(filePath) {
	try {
		return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
	} catch {
		return null;
	}
}
function resolveRecordPackageJsonPath(plugin) {
	const packageJsonPath = plugin.packageJson?.path;
	if (!packageJsonPath) return null;
	const rootDir = plugin.rootDir || path.dirname(plugin.manifestPath);
	const resolved = path.resolve(rootDir, packageJsonPath);
	const relative = path.relative(rootDir, resolved);
	return relative.startsWith("..") || path.isAbsolute(relative) ? null : resolved;
}
function hasStalePersistedPluginMetadata(index) {
	return index.plugins.some((plugin) => {
		if (!hasOptionalMissingPluginManifestFile(plugin)) {
			if (fileSignatureMatches(plugin.manifestPath, plugin.manifestFile) !== true) {
				const manifestHash = hashExistingFile(plugin.manifestPath);
				if (manifestHash && manifestHash !== plugin.manifestHash) return true;
			}
		}
		const packageJsonPath = resolveRecordPackageJsonPath(plugin);
		if (!plugin.packageJson?.hash) return false;
		if (!packageJsonPath) return true;
		const packageJsonSignatureMatches = fileSignatureMatches(packageJsonPath, plugin.packageJson.fileSignature);
		if (packageJsonSignatureMatches === true && plugin.origin === "bundled") return false;
		if (packageJsonSignatureMatches === false) return hashExistingFile(packageJsonPath) !== plugin.packageJson.hash;
		return hashExistingFile(packageJsonPath) !== plugin.packageJson.hash;
	});
}
function loadSnapshotInstallRecords(params, env) {
	return loadInstalledPluginIndexInstallRecordsSync({
		env,
		...params.stateDir ? { stateDir: params.stateDir } : {},
		...params.filePath ? { filePath: params.filePath } : params.pluginIndexFilePath ? { filePath: params.pluginIndexFilePath } : {}
	});
}
function hasRecoveredInstallRecordsMissingFromPersistedIndex(index, installRecords) {
	const persistedRecords = extractPluginInstallRecordsFromInstalledPluginIndex(index);
	const persistedPluginIds = new Set(index.plugins.map((plugin) => plugin.pluginId));
	return Object.keys(installRecords).some((pluginId) => !persistedRecords[pluginId] || !persistedPluginIds.has(pluginId));
}
function loadPluginRegistrySnapshotWithMetadata(params = {}) {
	if (params.index) return {
		snapshot: params.index,
		source: "provided",
		diagnostics: []
	};
	const env = params.env ?? process.env;
	const diagnostics = [];
	const disabledByCaller = params.preferPersisted === false;
	const disabledByEnv = hasEnvFlag(env, DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV);
	const persistedReadsEnabled = !disabledByCaller && !disabledByEnv;
	const persistedInstallRecordReadsEnabled = !disabledByEnv;
	let persistedIndex = null;
	if (persistedInstallRecordReadsEnabled) {
		persistedIndex = readPersistedInstalledPluginIndexSync(params);
		if (persistedReadsEnabled && persistedIndex) if (params.config && persistedIndex.policyHash !== resolveInstalledPluginIndexPolicyHash(params.config)) diagnostics.push({
			level: "warn",
			code: "persisted-registry-stale-policy",
			message: "Persisted plugin registry policy does not match current config; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry."
		});
		else if (hasMissingPersistedPluginSource(persistedIndex)) diagnostics.push({
			level: "warn",
			code: "persisted-registry-stale-source",
			message: "Persisted plugin registry points at missing plugin files; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry."
		});
		else if (hasMismatchedPersistedBundledPluginRoot(persistedIndex, env)) diagnostics.push({
			level: "warn",
			code: "persisted-registry-stale-source",
			message: "Persisted plugin registry points at a different bundled plugin tree; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry."
		});
		else if (hasStalePersistedPluginMetadata(persistedIndex)) diagnostics.push({
			level: "warn",
			code: "persisted-registry-stale-source",
			message: "Persisted plugin registry metadata no longer matches plugin manifest or package files; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry."
		});
		else if (hasRecoveredInstallRecordsMissingFromPersistedIndex(persistedIndex, loadSnapshotInstallRecords(params, env))) diagnostics.push({
			level: "warn",
			code: "persisted-registry-stale-source",
			message: "Persisted plugin registry is missing recoverable managed npm plugins; using derived plugin index. Run `openclaw plugins registry --refresh` to update the persisted registry."
		});
		else return {
			snapshot: persistedIndex,
			source: "persisted",
			diagnostics
		};
		else if (persistedReadsEnabled) diagnostics.push({
			level: "info",
			code: "persisted-registry-missing",
			message: "Persisted plugin registry is missing or invalid; using derived plugin index."
		});
	} else diagnostics.push({
		level: "warn",
		code: "persisted-registry-disabled",
		message: disabledByEnv ? `${formatDeprecatedPersistedRegistryDisableWarning()} Using legacy derived plugin index.` : "Persisted plugin registry reads are disabled by the caller; using derived plugin index."
	});
	return {
		snapshot: loadInstalledPluginIndex({
			...params,
			...persistedInstallRecordReadsEnabled ? {} : { installRecords: params.installRecords ?? {} }
		}),
		source: "derived",
		diagnostics
	};
}
function resolveSnapshot(params = {}) {
	return loadPluginRegistrySnapshotWithMetadata(params).snapshot;
}
function loadPluginRegistrySnapshot(params = {}) {
	return resolveSnapshot(params);
}
function getPluginRecord(params) {
	return getInstalledPluginRecord(resolveSnapshot(params), params.pluginId);
}
function isPluginEnabled(params) {
	return isInstalledPluginEnabled(resolveSnapshot(params), params.pluginId, params.config);
}
function inspectPluginRegistry(params = {}) {
	return inspectPersistedInstalledPluginIndex(params);
}
function refreshPluginRegistry(params) {
	return refreshPersistedInstalledPluginIndex(params);
}
//#endregion
//#region src/plugins/plugin-registry-contributions.ts
function normalizeContributionId(value) {
	return value.trim();
}
function sortUnique(values) {
	return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].toSorted((left, right) => left.localeCompare(right));
}
function collectObjectKeys(value) {
	return value ? Object.keys(value) : [];
}
function collectContractKeys(plugin) {
	const contracts = plugin.contracts;
	if (!contracts) return [];
	return Object.entries(contracts).flatMap(([key, value]) => Array.isArray(value) && value.length > 0 ? [key] : []);
}
function listManifestContractValues(plugin, contract) {
	return plugin.contracts?.[contract] ?? [];
}
function loadManifestContractRegistry(params) {
	return loadPluginManifestRegistryForPluginRegistry({
		...params,
		pluginIds: params.onlyPluginIds,
		includeDisabled: true
	});
}
function listManifestContributionIds(plugin, contribution) {
	switch (contribution) {
		case "providers": return plugin.providers;
		case "channels": return plugin.channels;
		case "channelConfigs": return collectObjectKeys(plugin.channelConfigs);
		case "setupProviders": return plugin.setup?.providers?.map((provider) => provider.id) ?? [];
		case "cliBackends": return [...plugin.cliBackends, ...plugin.setup?.cliBackends ?? []];
		case "modelCatalogProviders": return [...collectObjectKeys(plugin.modelCatalog?.providers), ...collectObjectKeys(plugin.modelCatalog?.aliases)];
		case "commandAliases": return plugin.commandAliases?.map((alias) => alias.name) ?? [];
		case "contracts": return collectContractKeys(plugin);
	}
	return [];
}
function resolveContributionPluginIds(params) {
	if (params.includeDisabled) return params.index.plugins.map((plugin) => plugin.pluginId);
	return params.index.plugins.filter((plugin) => isInstalledPluginEnabled(params.index, plugin.pluginId, params.config)).map((plugin) => plugin.pluginId);
}
function loadContributionManifestRegistry(params) {
	return loadPluginManifestRegistryForInstalledIndex({
		index: params.index,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		pluginIds: resolveContributionPluginIds({
			index: params.index,
			includeDisabled: params.includeDisabled,
			config: params.config
		}),
		includeDisabled: true
	});
}
function listContributionManifestPlugins(params) {
	const plugins = params.lookUpTable?.plugins;
	if (plugins) {
		const enabledPluginIds = new Set(resolveContributionPluginIds({
			index: params.index,
			includeDisabled: params.includeDisabled,
			config: params.config
		}));
		return plugins.filter((plugin) => enabledPluginIds.has(plugin.id));
	}
	return loadContributionManifestRegistry({
		...params,
		index: params.index
	}).plugins;
}
function resolveContributionOwnerMap(table, contribution) {
	switch (contribution) {
		case "channels": return table.owners.channels;
		case "channelConfigs": return table.owners.channelConfigs;
		case "providers": return table.owners.providers;
		case "modelCatalogProviders": return table.owners.modelCatalogProviders;
		case "cliBackends": return table.owners.cliBackends;
		case "setupProviders": return table.owners.setupProviders;
		case "commandAliases": return table.owners.commandAliases;
		case "contracts": return table.owners.contracts;
	}
}
function filterContributionOwnerIds(params) {
	const enabledPluginIds = new Set(resolveContributionPluginIds({
		index: params.index,
		includeDisabled: params.includeDisabled,
		config: params.config
	}));
	return sortUnique(params.owners.filter((owner) => enabledPluginIds.has(owner)));
}
function loadPluginManifestRegistryForPluginRegistry(params = {}) {
	return loadPluginManifestRegistryForInstalledIndex({
		index: loadPluginRegistrySnapshot(params),
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		pluginIds: params.pluginIds,
		includeDisabled: params.includeDisabled,
		...params.bundledChannelConfigCollector ? { bundledChannelConfigCollector: params.bundledChannelConfigCollector } : {}
	});
}
function normalizePluginsConfigWithRegistry(config, index, options = {}) {
	return normalizePluginsConfigWithResolver(config, createPluginRegistryIdNormalizer(index, options));
}
function listPluginContributionIds(params) {
	const index = params.lookUpTable?.index ?? loadPluginRegistrySnapshot(params);
	return sortUnique(listContributionManifestPlugins({
		...params,
		index
	}).flatMap((plugin) => listManifestContributionIds(plugin, params.contribution)));
}
function resolvePluginContributionOwners(params) {
	const index = params.lookUpTable?.index ?? loadPluginRegistrySnapshot(params);
	if (params.lookUpTable && typeof params.matches === "string") {
		const owners = resolveContributionOwnerMap(params.lookUpTable, params.contribution)?.get(params.matches);
		if (owners) return filterContributionOwnerIds({
			owners,
			index,
			includeDisabled: params.includeDisabled,
			config: params.config
		});
		return [];
	}
	const matcher = typeof params.matches === "string" ? (contributionId) => contributionId === params.matches : params.matches;
	return sortUnique(listContributionManifestPlugins({
		...params,
		index
	}).flatMap((plugin) => listManifestContributionIds(plugin, params.contribution).some(matcher) ? [plugin.id] : []));
}
function resolveProviderOwners(params) {
	const providerId = normalizeProviderId(params.providerId);
	if (!providerId) return [];
	if (params.lookUpTable) {
		const index = params.lookUpTable.index;
		const owners = [];
		for (const [contributionId, ownerIds] of params.lookUpTable.owners.providers.entries()) if (normalizeProviderId(contributionId) === providerId) owners.push(...ownerIds);
		return filterContributionOwnerIds({
			owners,
			index,
			includeDisabled: params.includeDisabled,
			config: params.config
		});
	}
	return resolvePluginContributionOwners({
		...params,
		contribution: "providers",
		matches: (contributionId) => normalizeProviderId(contributionId) === providerId
	});
}
function resolveManifestContractPluginIds(params) {
	return loadManifestContractRegistry(params).plugins.filter((plugin) => (!params.origin || plugin.origin === params.origin) && listManifestContractValues(plugin, params.contract).length > 0).map((plugin) => plugin.id).toSorted((left, right) => left.localeCompare(right));
}
function resolveManifestContractPluginIdsByCompatibilityRuntimePath(params) {
	const normalizedPath = params.path?.trim();
	if (!normalizedPath) return [];
	return loadManifestContractRegistry(params).plugins.filter((plugin) => (!params.origin || plugin.origin === params.origin) && listManifestContractValues(plugin, params.contract).length > 0 && (plugin.configContracts?.compatibilityRuntimePaths ?? []).includes(normalizedPath)).map((plugin) => plugin.id).toSorted((left, right) => left.localeCompare(right));
}
function resolveManifestContractOwnerPluginId(params) {
	const normalizedValue = normalizeContributionId(params.value ?? "").toLowerCase();
	if (!normalizedValue) return;
	return loadManifestContractRegistry(params).plugins.find((plugin) => (!params.origin || plugin.origin === params.origin) && listManifestContractValues(plugin, params.contract).some((candidate) => normalizeContributionId(candidate).toLowerCase() === normalizedValue))?.id;
}
//#endregion
export { resolveManifestContractPluginIds as a, resolveProviderOwners as c, inspectPluginRegistry as d, isPluginEnabled as f, createPluginRegistryIdNormalizer as g, refreshPluginRegistry as h, resolveManifestContractOwnerPluginId as i, DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV as l, loadPluginRegistrySnapshotWithMetadata as m, loadPluginManifestRegistryForPluginRegistry as n, resolveManifestContractPluginIdsByCompatibilityRuntimePath as o, loadPluginRegistrySnapshot as p, normalizePluginsConfigWithRegistry as r, resolvePluginContributionOwners as s, listPluginContributionIds as t, getPluginRecord as u };
