import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import "./agent-scope-CtLXGcWm.js";
import { t as isBlockedObjectKey } from "./prototype-keys-gIgii6VQ.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { i as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { v as getCurrentPluginMetadataSnapshot } from "./plugin-registry-CgH_ZSlH.js";
import { n as getCachedPluginModuleLoader } from "./plugin-module-loader-cache-D0U0PNnl.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { a as getBundledChannelSetupPlugin } from "./bundled-0oTAwz0N.js";
import { a as resolveSetupChannelRegistration, t as channelPluginIdBelongsToManifest } from "./loader-channel-setup-BDSdQdHL.js";
import { i as listChannelPlugins } from "./registry-Bf5TpUad.js";
import { f as listConfiguredChannelIdsForReadOnlyScope, g as resolveDiscoverableScopedChannelPluginIds, u as hasExplicitChannelConfig } from "./channel-plugin-ids-nB-ga3MN.js";
import { n as normalizeChannelCommandDefaults, r as readOwnRecordValue, t as isSafeManifestChannelId } from "./read-only-command-defaults-B1U3-fyY.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
//#region src/channels/plugins/read-only.ts
const SOURCE_PLUGIN_LOADER_MODULE_CANDIDATES = ["../../plugins/loader.js", "../../plugins/loader.ts"];
const BUILT_PLUGIN_LOADER_MODULE_CANDIDATES = ["plugins/loader.js", "plugins/build-smoke-entry.js"];
const moduleLoaders = /* @__PURE__ */ new Map();
const log = createSubsystemLogger("channels");
let pluginLoaderModule;
function listBuiltPluginLoaderModuleCandidateUrls(importerUrl) {
	let importerPath;
	try {
		importerPath = fileURLToPath(importerUrl);
	} catch {
		return [];
	}
	const distMarker = `${path.sep}dist${path.sep}`;
	const distMarkerIndex = importerPath.lastIndexOf(distMarker);
	if (distMarkerIndex < 0) return [];
	const distRoot = importerPath.slice(0, distMarkerIndex + distMarker.length - 1);
	return BUILT_PLUGIN_LOADER_MODULE_CANDIDATES.map((candidate) => pathToFileURL(path.join(distRoot, candidate)));
}
function listPluginLoaderModuleCandidateUrls(importerUrl = import.meta.url) {
	const builtCandidates = listBuiltPluginLoaderModuleCandidateUrls(importerUrl);
	if (builtCandidates.length > 0) return builtCandidates;
	return SOURCE_PLUGIN_LOADER_MODULE_CANDIDATES.map((candidate) => new URL(candidate, importerUrl));
}
function loadPluginLoaderModule() {
	if (pluginLoaderModule) return pluginLoaderModule;
	for (const candidate of listPluginLoaderModuleCandidateUrls()) {
		const modulePath = fileURLToPath(candidate);
		try {
			pluginLoaderModule = getCachedPluginModuleLoader({
				cache: moduleLoaders,
				modulePath,
				importerUrl: import.meta.url,
				preferBuiltDist: true,
				loaderFilename: import.meta.url,
				tryNative: true
			})(modulePath);
			return pluginLoaderModule;
		} catch {}
	}
	throw new Error("Could not load plugin runtime loader for channel setup fallback.");
}
function addChannelPlugins(byId, plugins, options) {
	for (const plugin of plugins) {
		if (!plugin) continue;
		if (options?.onlyIds && !options.onlyIds.has(plugin.id)) continue;
		if (options?.allowOverwrite === false && byId.has(plugin.id)) continue;
		byId.set(plugin.id, plugin);
	}
}
function rebindChannelScopedString(value, sourceChannelId, targetChannelId) {
	const sourcePrefix = `channels.${sourceChannelId}`;
	if (value === sourcePrefix) return `channels.${targetChannelId}`;
	if (value.startsWith(`${sourcePrefix}.`)) return `channels.${targetChannelId}${value.slice(sourcePrefix.length)}`;
	return value;
}
function normalizeManifestText(value, fallback) {
	return sanitizeForLog(value?.trim() || fallback).trim();
}
function rebindChannelConfig(cfg, sourceChannelId, targetChannelId) {
	if (sourceChannelId === targetChannelId || !cfg.channels) return cfg;
	return {
		...cfg,
		channels: {
			...cfg.channels,
			[sourceChannelId]: cfg.channels[targetChannelId]
		}
	};
}
function restoreReboundChannelConfig(params) {
	if (params.sourceChannelId === params.targetChannelId || !params.updated.channels) return params.updated;
	const nextChannels = { ...params.updated.channels };
	if (Object.prototype.hasOwnProperty.call(nextChannels, params.sourceChannelId)) nextChannels[params.targetChannelId] = nextChannels[params.sourceChannelId];
	else delete nextChannels[params.targetChannelId];
	if (params.original.channels && Object.prototype.hasOwnProperty.call(params.original.channels, params.sourceChannelId)) nextChannels[params.sourceChannelId] = params.original.channels[params.sourceChannelId];
	else delete nextChannels[params.sourceChannelId];
	return {
		...params.updated,
		channels: nextChannels
	};
}
function getChannelConfigRecord(cfg, channelId) {
	if (!isSafeManifestChannelId(channelId)) return {};
	const channels = cfg.channels;
	if (!channels || typeof channels !== "object" || Array.isArray(channels)) return {};
	const entry = readOwnRecordValue(channels, channelId);
	return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
}
function listManifestChannelAccountIds(cfg, channelId) {
	const accounts = getChannelConfigRecord(cfg, channelId).accounts;
	if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) return [...new Set(Object.keys(accounts).filter((accountId) => !isBlockedObjectKey(accountId)).map((accountId) => normalizeAccountId(accountId)).filter((accountId) => !isBlockedObjectKey(accountId)))].toSorted((left, right) => left.localeCompare(right));
	return hasExplicitChannelConfig({
		config: cfg,
		channelId
	}) ? [DEFAULT_ACCOUNT_ID] : [];
}
function resolveManifestChannelAccountConfig(params) {
	const channelConfig = getChannelConfigRecord(params.cfg, params.channelId);
	const resolvedAccountId = normalizeAccountId(params.accountId);
	const accounts = channelConfig.accounts;
	if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) {
		const accountConfig = readOwnRecordValue(accounts, resolvedAccountId);
		if (accountConfig && typeof accountConfig === "object" && !Array.isArray(accountConfig)) return accountConfig;
	}
	return channelConfig;
}
function buildManifestChannelPlugin(params) {
	if (!isSafeManifestChannelId(params.channelId)) return;
	const catalogMeta = params.record.channelCatalogMeta?.id === params.channelId ? params.record.channelCatalogMeta : void 0;
	const channelConfigValue = params.record.channelConfigs ? readOwnRecordValue(params.record.channelConfigs, params.channelId) : void 0;
	if (!catalogMeta && (!channelConfigValue || typeof channelConfigValue !== "object" || Array.isArray(channelConfigValue)) && !params.record.channels.includes(params.channelId)) return;
	const channelConfig = channelConfigValue && typeof channelConfigValue === "object" && !Array.isArray(channelConfigValue) ? channelConfigValue : void 0;
	const label = normalizeManifestText(channelConfig?.label ?? catalogMeta?.label, params.record.name || params.channelId) || params.channelId;
	const blurb = normalizeManifestText(channelConfig?.description ?? catalogMeta?.blurb, params.record.description || "");
	const commands = normalizeChannelCommandDefaults(channelConfig?.commands ?? catalogMeta?.commands);
	return {
		id: params.channelId,
		meta: {
			id: params.channelId,
			label,
			selectionLabel: label,
			docsPath: `/channels/${encodeURIComponent(params.channelId)}`,
			blurb,
			...channelConfig?.preferOver?.length ? { preferOver: channelConfig.preferOver } : catalogMeta?.preferOver?.length ? { preferOver: catalogMeta.preferOver } : {}
		},
		capabilities: { chatTypes: ["direct"] },
		...commands ? { commands } : {},
		...channelConfig ? { configSchema: {
			schema: channelConfig.schema,
			...channelConfig.uiHints ? { uiHints: channelConfig.uiHints } : {},
			...channelConfig.runtime ? { runtime: channelConfig.runtime } : {}
		} } : {},
		config: {
			listAccountIds: (cfg) => listManifestChannelAccountIds(cfg, params.channelId),
			defaultAccountId: () => DEFAULT_ACCOUNT_ID,
			resolveAccount: (cfg, accountId) => ({
				accountId: normalizeAccountId(accountId),
				config: resolveManifestChannelAccountConfig({
					cfg,
					channelId: params.channelId,
					accountId
				})
			}),
			isEnabled: (_account, cfg) => getChannelConfigRecord(cfg, params.channelId).enabled !== false,
			isConfigured: (_account, cfg) => hasExplicitChannelConfig({
				config: cfg,
				channelId: params.channelId
			}),
			hasConfiguredState: ({ cfg }) => hasExplicitChannelConfig({
				config: cfg,
				channelId: params.channelId
			})
		}
	};
}
function canUseManifestChannelPlugin(record, channelId) {
	if (Boolean(record.channelConfigs && Object.prototype.hasOwnProperty.call(record.channelConfigs, channelId))) return record.setup?.requiresRuntime === false || !record.setupSource;
	return record.channelCatalogMeta?.id === channelId || !record.setupSource;
}
function loadSetupChannelPluginFromManifestRecord(params) {
	if (!params.record.setupSource || !params.record.channels.includes(params.channelId)) return {};
	try {
		const registration = resolveSetupChannelRegistration(getCachedPluginModuleLoader({
			cache: moduleLoaders,
			modulePath: params.record.setupSource,
			importerUrl: import.meta.url,
			preferBuiltDist: true,
			loaderFilename: import.meta.url,
			tryNative: true,
			cacheScopeKey: "read-only-setup-entry"
		})(params.record.setupSource));
		if (registration.loadError) return { failure: {
			channelId: params.channelId,
			pluginId: params.record.id,
			source: params.record.setupSource,
			message: `failed to load setup entry: ${formatErrorMessage(registration.loadError)}`
		} };
		if (!registration.plugin) return {};
		if (!channelPluginIdBelongsToManifest({
			channelId: registration.plugin.id,
			pluginId: params.record.id,
			manifestChannels: params.record.channels
		})) return {};
		return { plugin: cloneChannelPluginForChannelId(registration.plugin, params.channelId) };
	} catch (error) {
		const detail = formatErrorMessage(error);
		log.warn(`[channels] failed to load channel setup ${params.record.id}: ${detail}`);
		return { failure: {
			channelId: params.channelId,
			pluginId: params.record.id,
			source: params.record.setupSource,
			message: `failed to load setup entry: ${detail}`
		} };
	}
}
function collectChannelPluginLoadFailuresFromDiagnostics(params) {
	if (!params.diagnostics?.length || params.channelIds.length === 0) return [];
	const configuredChannelIds = new Set(params.channelIds);
	const recordsByPluginId = new Map(params.records.map((record) => [record.id, record]));
	const failures = [];
	for (const diagnostic of params.diagnostics) {
		if (diagnostic.level !== "error" || !diagnostic.pluginId) continue;
		const record = recordsByPluginId.get(diagnostic.pluginId);
		if (!record) continue;
		for (const channelId of record.channels) {
			if (!configuredChannelIds.has(channelId)) continue;
			failures.push({
				channelId,
				pluginId: record.id,
				source: diagnostic.source,
				message: diagnostic.message
			});
		}
	}
	return failures;
}
function rebindChannelPluginConfig(config, sourceChannelId, targetChannelId) {
	const rebind = (cfg) => rebindChannelConfig(cfg, sourceChannelId, targetChannelId);
	return {
		...config,
		listAccountIds: (cfg) => config.listAccountIds(rebind(cfg)),
		resolveAccount: (cfg, accountId) => config.resolveAccount(rebind(cfg), accountId),
		inspectAccount: config.inspectAccount ? (cfg, accountId) => config.inspectAccount?.(rebind(cfg), accountId) : void 0,
		defaultAccountId: config.defaultAccountId ? (cfg) => config.defaultAccountId?.(rebind(cfg)) ?? "" : void 0,
		setAccountEnabled: config.setAccountEnabled ? (params) => restoreReboundChannelConfig({
			original: params.cfg,
			updated: config.setAccountEnabled?.({
				...params,
				cfg: rebind(params.cfg)
			}) ?? params.cfg,
			sourceChannelId,
			targetChannelId
		}) : void 0,
		deleteAccount: config.deleteAccount ? (params) => restoreReboundChannelConfig({
			original: params.cfg,
			updated: config.deleteAccount?.({
				...params,
				cfg: rebind(params.cfg)
			}) ?? params.cfg,
			sourceChannelId,
			targetChannelId
		}) : void 0,
		isEnabled: config.isEnabled ? (account, cfg) => config.isEnabled?.(account, rebind(cfg)) ?? false : void 0,
		disabledReason: config.disabledReason ? (account, cfg) => config.disabledReason?.(account, rebind(cfg)) ?? "" : void 0,
		isConfigured: config.isConfigured ? (account, cfg) => config.isConfigured?.(account, rebind(cfg)) ?? false : void 0,
		unconfiguredReason: config.unconfiguredReason ? (account, cfg) => config.unconfiguredReason?.(account, rebind(cfg)) ?? "" : void 0,
		describeAccount: config.describeAccount ? (account, cfg) => config.describeAccount(account, rebind(cfg)) : void 0,
		resolveAllowFrom: config.resolveAllowFrom ? (params) => config.resolveAllowFrom?.({
			...params,
			cfg: rebind(params.cfg)
		}) : void 0,
		formatAllowFrom: config.formatAllowFrom ? (params) => config.formatAllowFrom?.({
			...params,
			cfg: rebind(params.cfg)
		}) ?? [] : void 0,
		hasConfiguredState: config.hasConfiguredState ? (params) => config.hasConfiguredState?.({
			...params,
			cfg: rebind(params.cfg)
		}) ?? false : void 0,
		hasPersistedAuthState: config.hasPersistedAuthState ? (params) => config.hasPersistedAuthState?.({
			...params,
			cfg: rebind(params.cfg)
		}) ?? false : void 0,
		resolveDefaultTo: config.resolveDefaultTo ? (params) => config.resolveDefaultTo?.({
			...params,
			cfg: rebind(params.cfg)
		}) : void 0
	};
}
function rebindChannelPluginSecrets(secrets, sourceChannelId, targetChannelId) {
	if (!secrets) return;
	return {
		...secrets,
		secretTargetRegistryEntries: secrets.secretTargetRegistryEntries?.map((entry) => ({
			...entry,
			id: rebindChannelScopedString(entry.id, sourceChannelId, targetChannelId),
			pathPattern: rebindChannelScopedString(entry.pathPattern, sourceChannelId, targetChannelId),
			...entry.refPathPattern ? { refPathPattern: rebindChannelScopedString(entry.refPathPattern, sourceChannelId, targetChannelId) } : {}
		})),
		unsupportedSecretRefSurfacePatterns: secrets.unsupportedSecretRefSurfacePatterns?.map((pattern) => rebindChannelScopedString(pattern, sourceChannelId, targetChannelId)),
		collectRuntimeConfigAssignments: secrets.collectRuntimeConfigAssignments ? (params) => secrets.collectRuntimeConfigAssignments?.({
			...params,
			config: rebindChannelConfig(params.config, sourceChannelId, targetChannelId)
		}) : void 0
	};
}
function cloneChannelPluginForChannelId(plugin, channelId) {
	if (plugin.id === channelId && plugin.meta.id === channelId) return plugin;
	const sourceChannelId = plugin.id;
	return {
		...plugin,
		id: channelId,
		meta: {
			...plugin.meta,
			id: channelId
		},
		config: rebindChannelPluginConfig(plugin.config, sourceChannelId, channelId),
		secrets: rebindChannelPluginSecrets(plugin.secrets, sourceChannelId, channelId)
	};
}
function addSetupChannelPlugins(byId, setups, options) {
	for (const setup of setups) {
		const ownedMissingChannelIds = options.ownedMissingChannelIdsByPluginId.get(setup.pluginId)?.filter(isSafeManifestChannelId);
		if (!ownedMissingChannelIds || ownedMissingChannelIds.length === 0) continue;
		if (ownedMissingChannelIds.includes(setup.plugin.id)) {
			addChannelPlugins(byId, [setup.plugin], {
				onlyIds: new Set(ownedMissingChannelIds),
				allowOverwrite: false
			});
			addChannelPlugins(byId, ownedMissingChannelIds.filter((channelId) => channelId !== setup.plugin.id).map((channelId) => cloneChannelPluginForChannelId(setup.plugin, channelId)), {
				onlyIds: new Set(ownedMissingChannelIds),
				allowOverwrite: false
			});
			continue;
		}
		const ownedChannelIds = (options.ownedChannelIdsByPluginId.get(setup.pluginId) ?? []).filter(isSafeManifestChannelId);
		if (setup.plugin.id !== setup.pluginId && !ownedChannelIds.includes(setup.plugin.id)) continue;
		addChannelPlugins(byId, ownedMissingChannelIds.map((channelId) => cloneChannelPluginForChannelId(setup.plugin, channelId)), {
			onlyIds: new Set(ownedMissingChannelIds),
			allowOverwrite: false
		});
	}
}
function addManifestChannelPlugins(byId, records, options) {
	const channelIds = new Set(options.channelIds);
	for (const record of records) {
		if (!options.pluginIds.has(record.id)) continue;
		for (const channelId of record.channels) {
			if (!isSafeManifestChannelId(channelId)) continue;
			if (!channelIds.has(channelId)) continue;
			if (!canUseManifestChannelPlugin(record, channelId)) continue;
			addChannelPlugins(byId, [buildManifestChannelPlugin({
				record,
				channelId
			})], {
				onlyIds: channelIds,
				allowOverwrite: false
			});
		}
	}
}
function resolveReadOnlyWorkspaceDir(cfg, options) {
	return options.workspaceDir ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}
function listExternalChannelManifestRecords(records) {
	return records.filter((plugin) => plugin.origin !== "bundled" && plugin.channels.length > 0);
}
function listBundledChannelManifestRecords(records) {
	return records.filter((plugin) => plugin.origin === "bundled" && plugin.channels.length > 0);
}
function listPluginIdsForChannels(records, channelIds) {
	const requestedChannelIds = new Set(channelIds);
	return records.filter((plugin) => plugin.channels.some((channelId) => requestedChannelIds.has(channelId))).map((plugin) => plugin.id).toSorted((left, right) => left.localeCompare(right));
}
function resolveExternalReadOnlyChannelPluginIds(params) {
	if (params.channelIds.length === 0) return [];
	const candidatePluginIds = resolveDiscoverableScopedChannelPluginIds({
		config: params.cfg,
		activationSourceConfig: params.activationSourceConfig,
		channelIds: params.channelIds,
		workspaceDir: params.workspaceDir,
		env: params.env,
		manifestRecords: params.records
	});
	if (candidatePluginIds.length === 0) return [];
	const requestedChannelIds = new Set(params.channelIds);
	const candidatePluginIdSet = new Set(candidatePluginIds);
	return params.records.filter((plugin) => candidatePluginIdSet.has(plugin.id) && plugin.channels.some((channelId) => requestedChannelIds.has(channelId))).map((plugin) => plugin.id).toSorted((left, right) => left.localeCompare(right));
}
function listReadOnlyChannelPluginsForConfig(cfg, options) {
	return resolveReadOnlyChannelPluginsForConfig(cfg, options).plugins;
}
function resolveReadOnlyChannelPluginsForConfig(cfg, options = {}) {
	const env = options.env ?? process.env;
	const workspaceDir = resolveReadOnlyWorkspaceDir(cfg, options);
	const manifestRecords = (options.stateDir === void 0 ? getCurrentPluginMetadataSnapshot({
		config: cfg,
		env,
		workspaceDir
	}) : void 0)?.plugins ?? loadPluginMetadataSnapshot({
		config: cfg,
		stateDir: options.stateDir,
		workspaceDir,
		env
	}).plugins;
	const bundledManifestRecords = listBundledChannelManifestRecords(manifestRecords);
	const externalManifestRecords = listExternalChannelManifestRecords(manifestRecords);
	const configuredChannelIds = [...new Set(listConfiguredChannelIdsForReadOnlyScope({
		config: cfg,
		activationSourceConfig: options.activationSourceConfig ?? cfg,
		workspaceDir,
		env,
		includePersistedAuthState: options.includePersistedAuthState,
		manifestRecords
	}))].filter(isSafeManifestChannelId);
	const byId = /* @__PURE__ */ new Map();
	const loadFailures = [];
	addChannelPlugins(byId, listChannelPlugins());
	if (options.includeSetupFallbackPlugins === true) for (const channelId of configuredChannelIds) {
		if (byId.has(channelId)) continue;
		const setupResults = bundledManifestRecords.filter((record) => record.channels.includes(channelId)).map((record) => loadSetupChannelPluginFromManifestRecord({
			record,
			channelId
		}));
		loadFailures.push(...setupResults.map((result) => result.failure).filter((failure) => Boolean(failure)));
		addChannelPlugins(byId, [setupResults.map((result) => result.plugin).find((plugin) => plugin) ?? getBundledChannelSetupPlugin(channelId, env)]);
	}
	const bundledManifestMissingChannelIds = configuredChannelIds.filter((channelId) => !byId.has(channelId));
	addManifestChannelPlugins(byId, bundledManifestRecords, {
		pluginIds: new Set(listPluginIdsForChannels(bundledManifestRecords, bundledManifestMissingChannelIds)),
		channelIds: bundledManifestMissingChannelIds
	});
	const missingConfiguredChannelIds = configuredChannelIds.filter((channelId) => !byId.has(channelId));
	const externalPluginIds = resolveExternalReadOnlyChannelPluginIds({
		cfg,
		activationSourceConfig: options.activationSourceConfig ?? cfg,
		channelIds: missingConfiguredChannelIds,
		records: externalManifestRecords,
		workspaceDir,
		env
	});
	if (externalPluginIds.length > 0) {
		const externalPluginIdSet = new Set(externalPluginIds);
		const ownedChannelIdsByPluginId = new Map(externalManifestRecords.filter((record) => externalPluginIdSet.has(record.id)).map((record) => [record.id, record.channels]));
		if (missingConfiguredChannelIds.length > 0 && options.includeSetupFallbackPlugins === true) {
			const missingChannelIdSet = new Set(missingConfiguredChannelIds);
			const ownedMissingChannelIdsByPluginId = new Map([...ownedChannelIdsByPluginId].map(([pluginId, channelIds]) => [pluginId, channelIds.filter((channelId) => missingChannelIdSet.has(channelId))]));
			const registry = loadPluginLoaderModule().loadOpenClawPlugins({
				config: cfg,
				activationSourceConfig: options.activationSourceConfig ?? cfg,
				env,
				workspaceDir,
				cache: false,
				activate: false,
				includeSetupOnlyChannelPlugins: true,
				forceSetupOnlyChannelPlugins: true,
				requireSetupEntryForSetupOnlyChannelPlugins: true,
				onlyPluginIds: externalPluginIds
			});
			loadFailures.push(...collectChannelPluginLoadFailuresFromDiagnostics({
				diagnostics: registry.diagnostics,
				records: externalManifestRecords,
				channelIds: missingConfiguredChannelIds
			}));
			addSetupChannelPlugins(byId, registry.channelSetups, {
				ownedChannelIdsByPluginId,
				ownedMissingChannelIdsByPluginId
			});
		}
		addManifestChannelPlugins(byId, externalManifestRecords, {
			pluginIds: externalPluginIdSet,
			channelIds: missingConfiguredChannelIds.filter((channelId) => !byId.has(channelId))
		});
	}
	return {
		plugins: [...byId.values()],
		configuredChannelIds,
		missingConfiguredChannelIds: configuredChannelIds.filter((channelId) => !byId.has(channelId)),
		loadFailures
	};
}
//#endregion
export { listReadOnlyChannelPluginsForConfig as n, resolveReadOnlyChannelPluginsForConfig as r, listPluginLoaderModuleCandidateUrls as t };
