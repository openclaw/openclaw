import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { t as sanitizeForLog } from "./ansi-Dqm1lzVL.js";
import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { p as resolveUserPath } from "./utils-CCskKJVV.js";
import { o as resolveCompatibilityHostVersion } from "./version-Ew9InAD4.js";
import { c as resolvePluginActivationDecisionShared, i as normalizePluginsConfigWithResolver$1, l as toPluginActivationState, n as identityNormalizePluginId, r as isBundledChannelEnabledByChannelConfig$1, s as resolveMemorySlotDecisionShared, t as hasExplicitPluginConfig$1 } from "./config-normalization-shared-BkjbUp88.js";
import { t as isBlockedObjectKey } from "./prototype-keys-RBElZn9Q.js";
import { a as normalizeOptionalTrimmedStringList } from "./string-normalization-rJ4BOsjW.js";
import { d as isPathInside, f as safeRealpathSync, t as discoverOpenClawPlugins, v as loadBundleManifest, w as loadPluginManifest } from "./discovery-B19Xdk1_.js";
import { a as readJsonFileSync, i as readJsonFile } from "./json-files-BvzDldMA.js";
import { t as checkMinHostVersion } from "./min-host-version-DBJ-HE8w.js";
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
function extractPluginInstallRecordsFromPersistedInstalledPluginIndex(index) {
	if (!isRecord(index) || !Array.isArray(index.plugins)) return null;
	if (Object.prototype.hasOwnProperty.call(index, "installRecords")) return readRecordMap(index.installRecords) ?? {};
	const records = {};
	for (const entry of index.plugins) {
		if (!isRecord(entry) || typeof entry.pluginId !== "string" || !isRecord(entry.installRecord)) continue;
		records[entry.pluginId] = structuredClone(entry.installRecord);
	}
	return records;
}
async function readPersistedInstalledPluginIndexInstallRecords(options = {}) {
	return extractPluginInstallRecordsFromPersistedInstalledPluginIndex(await readJsonFile(resolveInstalledPluginIndexStorePath(options)));
}
function readPersistedInstalledPluginIndexInstallRecordsSync(options = {}) {
	return extractPluginInstallRecordsFromPersistedInstalledPluginIndex(readJsonFileSync(resolveInstalledPluginIndexStorePath(options)));
}
async function loadInstalledPluginIndexInstallRecords(params = {}) {
	return cloneInstallRecords(await readPersistedInstalledPluginIndexInstallRecords(params) ?? {});
}
function loadInstalledPluginIndexInstallRecordsSync(params = {}) {
	return cloneInstallRecords(readPersistedInstalledPluginIndexInstallRecordsSync(params) ?? {});
}
//#endregion
//#region src/plugins/config-policy.ts
function normalizePluginsConfigWithResolver(config, normalizePluginId = identityNormalizePluginId) {
	return normalizePluginsConfigWithResolver$1(config, normalizePluginId);
}
function resolvePluginActivationState(params) {
	return toPluginActivationState(resolvePluginActivationDecisionShared({
		...params,
		activationSource: {
			plugins: params.sourceConfig ?? params.config,
			rootConfig: params.sourceRootConfig ?? params.rootConfig
		},
		isBundledChannelEnabledByChannelConfig
	}));
}
const hasExplicitPluginConfig = hasExplicitPluginConfig$1;
const isBundledChannelEnabledByChannelConfig = isBundledChannelEnabledByChannelConfig$1;
function resolveEffectivePluginActivationState(params) {
	return resolvePluginActivationState(params);
}
function resolveMemorySlotDecision(params) {
	return resolveMemorySlotDecisionShared(params);
}
//#endregion
//#region src/plugins/manifest-registry.ts
/**
* Resolve a plugin source path, falling back from .ts to .js when the
* .ts file doesn't exist on disk (e.g. in dist builds where only .js
* is emitted but the manifest still references the .ts entry).
*/
function resolvePluginSourcePath(sourcePath) {
	if (fs.existsSync(sourcePath)) return sourcePath;
	if (sourcePath.endsWith(".ts")) {
		const jsPath = sourcePath.slice(0, -3) + ".js";
		if (fs.existsSync(jsPath)) return jsPath;
	}
	return sourcePath;
}
const PLUGIN_ORIGIN_RANK = {
	config: 0,
	workspace: 1,
	global: 2,
	bundled: 3
};
function safeStatMtimeMs(filePath) {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return null;
	}
}
function normalizePreferredPluginIds(raw) {
	return normalizeOptionalTrimmedStringList(raw);
}
function normalizePackageChannelCommands(commands) {
	if (!commands || typeof commands !== "object" || Array.isArray(commands)) return;
	const record = commands;
	const nativeCommandsAutoEnabled = typeof record.nativeCommandsAutoEnabled === "boolean" ? record.nativeCommandsAutoEnabled : void 0;
	const nativeSkillsAutoEnabled = typeof record.nativeSkillsAutoEnabled === "boolean" ? record.nativeSkillsAutoEnabled : void 0;
	return nativeCommandsAutoEnabled !== void 0 || nativeSkillsAutoEnabled !== void 0 ? {
		...nativeCommandsAutoEnabled !== void 0 ? { nativeCommandsAutoEnabled } : {},
		...nativeSkillsAutoEnabled !== void 0 ? { nativeSkillsAutoEnabled } : {}
	} : void 0;
}
function mergePackageChannelMetaIntoChannelConfigs(params) {
	const channelId = params.packageChannel?.id?.trim();
	if (!channelId || isBlockedObjectKey(channelId) || !params.channelConfigs || !Object.prototype.hasOwnProperty.call(params.channelConfigs, channelId)) return params.channelConfigs;
	const existing = params.channelConfigs[channelId];
	if (!existing) return params.channelConfigs;
	const label = existing.label ?? normalizeOptionalString(params.packageChannel?.label) ?? "";
	const description = existing.description ?? normalizeOptionalString(params.packageChannel?.blurb) ?? "";
	const preferOver = existing.preferOver ?? normalizePreferredPluginIds(params.packageChannel?.preferOver);
	const commands = existing.commands ?? normalizePackageChannelCommands(params.packageChannel?.commands);
	const merged = Object.create(null);
	for (const [key, value] of Object.entries(params.channelConfigs)) if (!isBlockedObjectKey(key)) merged[key] = value;
	merged[channelId] = {
		...existing,
		...label ? { label } : {},
		...description ? { description } : {},
		...preferOver?.length ? { preferOver } : {},
		...commands ? { commands } : {}
	};
	return merged;
}
function buildRecord(params) {
	const channelConfigs = mergePackageChannelMetaIntoChannelConfigs({
		channelConfigs: params.candidate.origin === "bundled" && params.bundledChannelConfigCollector ? params.bundledChannelConfigCollector({
			pluginDir: params.candidate.packageDir ?? params.candidate.rootDir,
			manifest: params.manifest,
			packageManifest: params.candidate.packageManifest
		}) : params.manifest.channelConfigs,
		packageChannel: params.candidate.packageManifest?.channel
	});
	const packageChannelCommands = normalizePackageChannelCommands(params.candidate.packageManifest?.channel?.commands);
	return {
		id: params.manifest.id,
		name: normalizeOptionalString(params.manifest.name) ?? params.candidate.packageName,
		description: normalizeOptionalString(params.manifest.description) ?? params.candidate.packageDescription,
		version: normalizeOptionalString(params.manifest.version) ?? params.candidate.packageVersion,
		packageName: params.candidate.packageName,
		packageVersion: params.candidate.packageVersion,
		packageDescription: params.candidate.packageDescription,
		enabledByDefault: params.manifest.enabledByDefault === true ? true : void 0,
		autoEnableWhenConfiguredProviders: params.manifest.autoEnableWhenConfiguredProviders,
		legacyPluginIds: params.manifest.legacyPluginIds,
		format: params.candidate.format ?? "openclaw",
		bundleFormat: params.candidate.bundleFormat,
		kind: params.manifest.kind,
		channels: params.manifest.channels ?? [],
		providers: params.manifest.providers ?? [],
		providerDiscoverySource: params.manifest.providerDiscoveryEntry ? resolvePluginSourcePath(path.resolve(params.candidate.rootDir, params.manifest.providerDiscoveryEntry)) : void 0,
		modelSupport: params.manifest.modelSupport,
		modelCatalog: params.manifest.modelCatalog,
		modelPricing: params.manifest.modelPricing,
		modelIdNormalization: params.manifest.modelIdNormalization,
		providerEndpoints: params.manifest.providerEndpoints,
		providerRequest: params.manifest.providerRequest,
		cliBackends: params.manifest.cliBackends ?? [],
		syntheticAuthRefs: params.manifest.syntheticAuthRefs ?? [],
		nonSecretAuthMarkers: params.manifest.nonSecretAuthMarkers ?? [],
		commandAliases: params.manifest.commandAliases,
		providerAuthEnvVars: params.manifest.providerAuthEnvVars,
		providerAuthAliases: params.manifest.providerAuthAliases,
		channelEnvVars: params.manifest.channelEnvVars,
		providerAuthChoices: params.manifest.providerAuthChoices,
		activation: params.manifest.activation,
		setup: params.manifest.setup,
		packageManifest: params.candidate.packageManifest,
		packageDependencies: params.candidate.packageDependencies,
		packageOptionalDependencies: params.candidate.packageOptionalDependencies,
		packageChannel: params.candidate.packageManifest?.channel,
		packageInstall: params.candidate.packageManifest?.install,
		qaRunners: params.manifest.qaRunners,
		skills: params.manifest.skills ?? [],
		settingsFiles: [],
		hooks: [],
		origin: params.candidate.origin,
		workspaceDir: params.candidate.workspaceDir,
		rootDir: params.candidate.rootDir,
		source: params.candidate.source,
		setupSource: params.candidate.setupSource,
		startupDeferConfiguredChannelFullLoadUntilAfterListen: params.candidate.packageManifest?.startup?.deferConfiguredChannelFullLoadUntilAfterListen === true,
		manifestPath: params.manifestPath,
		schemaCacheKey: params.schemaCacheKey,
		configSchema: params.configSchema,
		configUiHints: params.manifest.uiHints,
		contracts: params.manifest.contracts,
		mediaUnderstandingProviderMetadata: params.manifest.mediaUnderstandingProviderMetadata,
		imageGenerationProviderMetadata: params.manifest.imageGenerationProviderMetadata,
		videoGenerationProviderMetadata: params.manifest.videoGenerationProviderMetadata,
		musicGenerationProviderMetadata: params.manifest.musicGenerationProviderMetadata,
		toolMetadata: params.manifest.toolMetadata,
		configContracts: params.manifest.configContracts,
		channelConfigs,
		...params.candidate.packageManifest?.channel?.id ? { channelCatalogMeta: {
			id: params.candidate.packageManifest.channel.id,
			...typeof params.candidate.packageManifest.channel.label === "string" ? { label: params.candidate.packageManifest.channel.label } : {},
			...typeof params.candidate.packageManifest.channel.blurb === "string" ? { blurb: params.candidate.packageManifest.channel.blurb } : {},
			...params.candidate.packageManifest.channel.preferOver ? { preferOver: params.candidate.packageManifest.channel.preferOver } : {},
			...packageChannelCommands ? { commands: packageChannelCommands } : {}
		} } : {}
	};
}
function buildBundleRecord(params) {
	return {
		id: params.manifest.id,
		name: normalizeOptionalString(params.manifest.name) ?? params.candidate.idHint,
		description: normalizeOptionalString(params.manifest.description),
		version: normalizeOptionalString(params.manifest.version),
		packageName: params.candidate.packageName,
		packageVersion: params.candidate.packageVersion,
		packageDescription: params.candidate.packageDescription,
		packageManifest: params.candidate.packageManifest,
		packageDependencies: params.candidate.packageDependencies,
		packageOptionalDependencies: params.candidate.packageOptionalDependencies,
		packageChannel: params.candidate.packageManifest?.channel,
		packageInstall: params.candidate.packageManifest?.install,
		format: "bundle",
		bundleFormat: params.candidate.bundleFormat,
		bundleCapabilities: params.manifest.capabilities,
		channels: [],
		providers: [],
		cliBackends: [],
		syntheticAuthRefs: [],
		nonSecretAuthMarkers: [],
		skills: params.manifest.skills ?? [],
		settingsFiles: params.manifest.settingsFiles ?? [],
		hooks: params.manifest.hooks ?? [],
		origin: params.candidate.origin,
		workspaceDir: params.candidate.workspaceDir,
		rootDir: params.candidate.rootDir,
		source: params.candidate.source,
		manifestPath: params.manifestPath,
		schemaCacheKey: void 0,
		configSchema: void 0,
		configUiHints: void 0,
		configContracts: void 0,
		channelConfigs: void 0
	};
}
function pushProviderAuthEnvVarsCompatDiagnostic(params) {
	if (params.record.origin === "bundled" || !params.record.providerAuthEnvVars) return;
	const setupProviderEnvVars = new Map((params.record.setup?.providers ?? []).map((provider) => [provider.id, new Set(provider.envVars ?? [])]));
	const providerIds = Object.entries(params.record.providerAuthEnvVars).filter(([providerId, envVars]) => {
		if (!providerId.trim() || envVars.length === 0) return false;
		const mirroredEnvVars = setupProviderEnvVars.get(providerId);
		return !mirroredEnvVars || envVars.some((envVar) => !mirroredEnvVars.has(envVar));
	}).map(([providerId]) => providerId).toSorted((left, right) => left.localeCompare(right));
	if (providerIds.length === 0) return;
	params.diagnostics.push({
		level: "warn",
		pluginId: sanitizeForLog(params.record.id),
		source: sanitizeForLog(params.record.manifestPath),
		message: `providerAuthEnvVars is deprecated compatibility metadata for provider env-var lookup; mirror ${providerIds.map(sanitizeForLog).join(", ")} env vars to setup.providers[].envVars before the deprecation window closes`
	});
}
function pushNonBundledChannelConfigDescriptorDiagnostic(params) {
	if (params.record.origin === "bundled" || params.record.format === "bundle") return;
	const declaredChannels = params.record.channels.map((channelId) => channelId.trim()).filter((channelId) => channelId.length > 0);
	if (declaredChannels.length === 0) return;
	const channelConfigs = params.record.channelConfigs ?? {};
	const missingChannels = declaredChannels.filter((channelId) => !Object.prototype.hasOwnProperty.call(channelConfigs, channelId));
	if (missingChannels.length === 0) return;
	const safeMissingChannels = missingChannels.map(sanitizeForLog);
	params.diagnostics.push({
		level: "warn",
		pluginId: sanitizeForLog(params.record.id),
		source: sanitizeForLog(params.record.manifestPath),
		message: `channel plugin manifest declares ${safeMissingChannels.join(", ")} without channelConfigs metadata; add openclaw.plugin.json#channelConfigs so config schema and setup surfaces work before runtime loads`
	});
}
function pushManifestCompatibilityDiagnostics(params) {
	pushProviderAuthEnvVarsCompatDiagnostic(params);
	pushNonBundledChannelConfigDescriptorDiagnostic(params);
}
function matchesInstalledPluginRecord(params) {
	if (params.candidate.origin !== "global") return false;
	const record = params.installRecords[params.pluginId];
	if (!record) return false;
	const candidateSource = resolveUserPath(params.candidate.source, params.env);
	const trackedPaths = [record.installPath, record.sourcePath].filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => resolveUserPath(entry, params.env));
	if (trackedPaths.length === 0) return false;
	return trackedPaths.some((trackedPath) => {
		return candidateSource === trackedPath || isPathInside(trackedPath, candidateSource);
	});
}
function resolveDuplicatePrecedenceRank(params) {
	if (params.candidate.origin === "config") return 0;
	if (params.candidate.origin === "global" && matchesInstalledPluginRecord({
		pluginId: params.pluginId,
		candidate: params.candidate,
		config: params.config,
		env: params.env,
		installRecords: params.installRecords
	})) return 1;
	if (params.candidate.origin === "bundled") return 2;
	if (params.candidate.origin === "workspace") return 3;
	return 4;
}
function isIntentionalInstalledBundledDuplicate(params) {
	const leftIsInstalled = matchesInstalledPluginRecord({
		pluginId: params.pluginId,
		candidate: params.left,
		config: params.config,
		env: params.env,
		installRecords: params.installRecords
	});
	const rightIsInstalled = matchesInstalledPluginRecord({
		pluginId: params.pluginId,
		candidate: params.right,
		config: params.config,
		env: params.env,
		installRecords: params.installRecords
	});
	return leftIsInstalled && params.right.origin === "bundled" || rightIsInstalled && params.left.origin === "bundled";
}
function loadPluginManifestRegistry(params = {}) {
	const config = params.config ?? {};
	const normalized = normalizePluginsConfigWithResolver(config.plugins);
	const env = params.env ?? process.env;
	let installRecords = params.installRecords;
	let installRecordsLoaded = Boolean(params.installRecords);
	const getInstallRecords = () => {
		if (!installRecordsLoaded) {
			installRecords = loadInstalledPluginIndexInstallRecordsSync({ env });
			installRecordsLoaded = true;
		}
		return installRecords ?? {};
	};
	const discovery = params.candidates ? {
		candidates: params.candidates,
		diagnostics: params.diagnostics ?? []
	} : discoverOpenClawPlugins({
		workspaceDir: params.workspaceDir,
		extraPaths: normalized.loadPaths,
		env,
		installRecords: getInstallRecords()
	});
	const diagnostics = [...discovery.diagnostics];
	const candidates = discovery.candidates;
	const records = [];
	const seenIds = /* @__PURE__ */ new Map();
	const realpathCache = /* @__PURE__ */ new Map();
	const currentHostVersion = resolveCompatibilityHostVersion(env);
	for (const candidate of candidates) {
		const rejectHardlinks = candidate.origin !== "bundled";
		const isBundleRecord = (candidate.format ?? "openclaw") === "bundle";
		const manifestRes = candidate.origin === "bundled" && candidate.bundledManifest && candidate.bundledManifestPath ? {
			ok: true,
			manifest: candidate.bundledManifest,
			manifestPath: candidate.bundledManifestPath
		} : isBundleRecord && candidate.bundleFormat ? loadBundleManifest({
			rootDir: candidate.rootDir,
			bundleFormat: candidate.bundleFormat,
			rejectHardlinks
		}) : loadPluginManifest(candidate.rootDir, rejectHardlinks);
		if (!manifestRes.ok) {
			diagnostics.push({
				level: "error",
				message: manifestRes.error,
				source: manifestRes.manifestPath
			});
			continue;
		}
		const manifest = manifestRes.manifest;
		if (candidate.origin !== "bundled") {
			const allowLegacyBareMinHostVersion = candidate.origin === "global" && matchesInstalledPluginRecord({
				pluginId: manifest.id,
				candidate,
				config,
				env,
				installRecords: getInstallRecords()
			});
			const minHostVersionCheck = checkMinHostVersion({
				currentVersion: currentHostVersion,
				minHostVersion: candidate.packageManifest?.install?.minHostVersion,
				allowLegacyBareSemver: allowLegacyBareMinHostVersion
			});
			if (!minHostVersionCheck.ok) {
				const packageManifestSource = path.join(candidate.packageDir ?? candidate.rootDir, "package.json");
				diagnostics.push({
					level: minHostVersionCheck.kind === "invalid" ? "error" : "warn",
					pluginId: manifest.id,
					source: packageManifestSource,
					message: minHostVersionCheck.kind === "invalid" ? `plugin manifest invalid | ${minHostVersionCheck.error}` : minHostVersionCheck.kind === "unknown_host_version" ? `plugin requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host version could not be determined; skipping load` : `plugin requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host is ${minHostVersionCheck.currentVersion}; skipping load`
				});
				continue;
			}
		}
		const configSchema = "configSchema" in manifest ? manifest.configSchema : void 0;
		const schemaCacheKey = (() => {
			if (!configSchema) return;
			const manifestMtime = safeStatMtimeMs(manifestRes.manifestPath);
			return manifestMtime ? `${manifestRes.manifestPath}:${manifestMtime}` : manifestRes.manifestPath;
		})();
		const record = isBundleRecord ? buildBundleRecord({
			manifest,
			candidate,
			manifestPath: manifestRes.manifestPath
		}) : buildRecord({
			manifest,
			candidate,
			manifestPath: manifestRes.manifestPath,
			schemaCacheKey,
			configSchema,
			...params.bundledChannelConfigCollector ? { bundledChannelConfigCollector: params.bundledChannelConfigCollector } : {}
		});
		const existing = seenIds.get(manifest.id);
		if (existing) {
			const samePath = existing.candidate.rootDir === candidate.rootDir;
			if ((() => {
				if (samePath) return true;
				const existingReal = safeRealpathSync(existing.candidate.rootDir, realpathCache);
				const candidateReal = safeRealpathSync(candidate.rootDir, realpathCache);
				return Boolean(existingReal && candidateReal && existingReal === candidateReal);
			})()) {
				if (PLUGIN_ORIGIN_RANK[candidate.origin] < PLUGIN_ORIGIN_RANK[existing.candidate.origin]) {
					records[existing.recordIndex] = record;
					seenIds.set(manifest.id, {
						candidate,
						recordIndex: existing.recordIndex
					});
					pushManifestCompatibilityDiagnostics({
						record,
						diagnostics
					});
				}
				continue;
			}
			const candidateWins = resolveDuplicatePrecedenceRank({
				pluginId: manifest.id,
				candidate,
				config,
				env,
				installRecords: getInstallRecords()
			}) < resolveDuplicatePrecedenceRank({
				pluginId: manifest.id,
				candidate: existing.candidate,
				config,
				env,
				installRecords: getInstallRecords()
			});
			const winnerCandidate = candidateWins ? candidate : existing.candidate;
			const overriddenCandidate = candidateWins ? existing.candidate : candidate;
			if (candidateWins) {
				records[existing.recordIndex] = record;
				seenIds.set(manifest.id, {
					candidate,
					recordIndex: existing.recordIndex
				});
				pushManifestCompatibilityDiagnostics({
					record,
					diagnostics
				});
			}
			if (isIntentionalInstalledBundledDuplicate({
				pluginId: manifest.id,
				left: candidate,
				right: existing.candidate,
				config,
				env,
				installRecords: getInstallRecords()
			})) continue;
			diagnostics.push({
				level: "warn",
				pluginId: manifest.id,
				source: overriddenCandidate.source,
				message: winnerCandidate.origin === "config" ? `duplicate plugin id resolved by explicit config-selected plugin; ${overriddenCandidate.origin} plugin will be overridden by config plugin (${winnerCandidate.source})` : `duplicate plugin id detected; ${overriddenCandidate.origin} plugin will be overridden by ${winnerCandidate.origin} plugin (${winnerCandidate.source})`
			});
			continue;
		}
		seenIds.set(manifest.id, {
			candidate,
			recordIndex: records.length
		});
		records.push(record);
		pushManifestCompatibilityDiagnostics({
			record,
			diagnostics
		});
	}
	return {
		plugins: records,
		diagnostics
	};
}
//#endregion
export { resolveMemorySlotDecision as a, readPersistedInstalledPluginIndexInstallRecords as c, resolveEffectivePluginActivationState as i, readPersistedInstalledPluginIndexInstallRecordsSync as l, hasExplicitPluginConfig as n, loadInstalledPluginIndexInstallRecords as o, normalizePluginsConfigWithResolver as r, loadInstalledPluginIndexInstallRecordsSync as s, loadPluginManifestRegistry as t, resolveInstalledPluginIndexStorePath as u };
