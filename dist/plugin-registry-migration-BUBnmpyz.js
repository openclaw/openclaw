import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { f as loadInstalledPluginIndex, o as writePersistedInstalledPluginIndex, r as readPersistedInstalledPluginIndexSync, t as inspectPersistedInstalledPluginIndex } from "./installed-plugin-index-store-C1Oen9wR.js";
import { a as resolveInstalledPluginIndexStorePath, t as loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-record-reader-BvE-GqxR.js";
import { t as loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed-HgZGS-Bx.js";
import "./installed-plugin-index-records-BrXfmg6n.js";
import { n as stripShippedPluginInstallConfigRecords, t as extractShippedPluginInstallConfigRecords } from "./plugin-install-config-migration-tLi3gF_S.js";
import fs from "node:fs";
//#region src/commands/doctor/shared/plugin-registry-migration.ts
const DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV = "OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION";
const FORCE_PLUGIN_REGISTRY_MIGRATION_ENV = "OPENCLAW_FORCE_PLUGIN_REGISTRY_MIGRATION";
function hasEnvFlag(env, key) {
	const value = env?.[key]?.trim().toLowerCase();
	return Boolean(value && value !== "0" && value !== "false" && value !== "no");
}
function forceDeprecationWarning() {
	return `${FORCE_PLUGIN_REGISTRY_MIGRATION_ENV} is deprecated and will be removed after the plugin registry migration rollout; use doctor registry repair once available.`;
}
function preflightPluginRegistryInstallMigration(params = {}) {
	const env = params.env ?? process.env;
	const filePath = resolveInstalledPluginIndexStorePath(params);
	const force = hasEnvFlag(env, FORCE_PLUGIN_REGISTRY_MIGRATION_ENV);
	const deprecationWarnings = force ? [forceDeprecationWarning()] : [];
	if (hasEnvFlag(env, "OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION")) return {
		action: "disabled",
		filePath,
		force,
		deprecationWarnings
	};
	const pathExists = params.existsSync ?? fs.existsSync;
	if (!force && pathExists(filePath)) {
		if (readPersistedInstalledPluginIndexSync(params)) return {
			action: "skip-existing",
			filePath,
			force,
			deprecationWarnings
		};
	}
	return {
		action: "migrate",
		filePath,
		force,
		deprecationWarnings
	};
}
async function readMigrationConfig(params) {
	if (params.config) return params.config;
	if (params.readConfig) return await params.readConfig();
	return await (await import("./config/config.js")).readBestEffortConfig();
}
function normalizeRegistryReference(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed.toLowerCase() : void 0;
}
function createMigrationPluginIdNormalizer(index, manifests) {
	const aliases = /* @__PURE__ */ new Map();
	for (const plugin of index.plugins) {
		const pluginId = normalizeRegistryReference(plugin.pluginId);
		if (!pluginId) continue;
		aliases.set(pluginId, plugin.pluginId);
	}
	for (const plugin of manifests) {
		const pluginId = normalizeRegistryReference(plugin.id);
		if (!pluginId) continue;
		aliases.set(pluginId, plugin.id);
		for (const alias of [
			...plugin.providers,
			...plugin.channels,
			...plugin.setup?.providers?.map((provider) => provider.id) ?? [],
			...plugin.cliBackends,
			...plugin.setup?.cliBackends ?? [],
			...Object.keys(plugin.modelCatalog?.providers ?? {}),
			...plugin.legacyPluginIds ?? []
		]) {
			const normalizedAlias = normalizeRegistryReference(alias);
			if (normalizedAlias && !aliases.has(normalizedAlias)) aliases.set(normalizedAlias, plugin.id);
		}
	}
	return (pluginId) => {
		const normalized = normalizeRegistryReference(pluginId);
		return normalized ? aliases.get(normalized) ?? pluginId.trim() : pluginId.trim();
	};
}
function addPluginReference(references, normalizePluginId, value) {
	if (typeof value !== "string") return;
	const normalized = normalizePluginId(value);
	if (normalized) references.add(normalized);
}
function listConfiguredChannelIds(config) {
	const channels = config.channels;
	if (!channels || typeof channels !== "object" || Array.isArray(channels)) return /* @__PURE__ */ new Set();
	return new Set(Object.keys(channels).map((channelId) => normalizeRegistryReference(channelId)).filter((channelId) => Boolean(channelId)));
}
function listConfiguredModelProviderIds(config) {
	const providers = config.models?.providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return /* @__PURE__ */ new Set();
	return new Set(Object.keys(providers).map((providerId) => normalizeProviderId(providerId)).filter(Boolean));
}
function listMigrationRelevantPluginRecords(params) {
	const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
		index: params.index,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		includeDisabled: true
	});
	const manifestByPluginId = new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin]));
	const normalizePluginId = createMigrationPluginIdNormalizer(params.index, manifestRegistry.plugins);
	const referencedPluginIds = /* @__PURE__ */ new Set();
	const installedPluginIds = /* @__PURE__ */ new Set();
	for (const pluginId of Object.keys(params.installRecords)) addPluginReference(installedPluginIds, normalizePluginId, pluginId);
	const plugins = params.config.plugins;
	for (const pluginId of plugins?.allow ?? []) addPluginReference(referencedPluginIds, normalizePluginId, pluginId);
	for (const pluginId of plugins?.deny ?? []) addPluginReference(referencedPluginIds, normalizePluginId, pluginId);
	for (const pluginId of Object.keys(plugins?.entries ?? {})) addPluginReference(referencedPluginIds, normalizePluginId, pluginId);
	for (const pluginId of Object.values(plugins?.slots ?? {})) {
		if (normalizeRegistryReference(pluginId) === "none") continue;
		addPluginReference(referencedPluginIds, normalizePluginId, pluginId);
	}
	const configuredChannelIds = listConfiguredChannelIds(params.config);
	const configuredModelProviderIds = listConfiguredModelProviderIds(params.config);
	return params.index.plugins.filter((plugin) => {
		if (plugin.origin !== "bundled") return true;
		const manifest = manifestByPluginId.get(plugin.pluginId);
		if (plugin.enabledByDefault && (manifest?.providers.length ?? 0) > 0) return true;
		if (plugin.startup.memory) return true;
		if ((manifest?.commandAliases ?? []).some((alias) => alias.cliCommand)) return true;
		if (installedPluginIds.has(plugin.pluginId) || referencedPluginIds.has(plugin.pluginId)) return true;
		if ((manifest?.channels ?? []).some((channelId) => configuredChannelIds.has(normalizeRegistryReference(channelId) ?? ""))) return true;
		return (manifest?.providers ?? []).some((providerId) => configuredModelProviderIds.has(normalizeProviderId(providerId)));
	});
}
async function migratePluginRegistryForInstall(params = {}) {
	const preflight = preflightPluginRegistryInstallMigration(params);
	if (preflight.action === "disabled") return {
		status: "disabled",
		migrated: false,
		preflight
	};
	if (preflight.action === "skip-existing") return {
		status: "skip-existing",
		migrated: false,
		preflight
	};
	if (params.dryRun) return {
		status: "dry-run",
		migrated: false,
		preflight
	};
	const rawConfig = await readMigrationConfig(params);
	const config = stripShippedPluginInstallConfigRecords(rawConfig);
	const durableInstallRecords = params.installRecords ?? await loadInstalledPluginIndexInstallRecords(params);
	const installRecords = {
		...extractShippedPluginInstallConfigRecords(rawConfig),
		...durableInstallRecords
	};
	const migrationParams = {
		...params,
		config,
		installRecords
	};
	const inspection = await inspectPersistedInstalledPluginIndex(migrationParams);
	const candidateIndex = loadInstalledPluginIndex({ ...migrationParams });
	const current = {
		...candidateIndex,
		refreshReason: "migration",
		plugins: listMigrationRelevantPluginRecords({
			index: candidateIndex,
			config,
			installRecords,
			workspaceDir: params.workspaceDir,
			env: params.env
		})
	};
	await writePersistedInstalledPluginIndex(current, params);
	return {
		status: "migrated",
		migrated: true,
		preflight,
		inspection,
		current
	};
}
//#endregion
export { preflightPluginRegistryInstallMigration as i, FORCE_PLUGIN_REGISTRY_MIGRATION_ENV as n, migratePluginRegistryForInstall as r, DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV as t };
