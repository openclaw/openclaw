import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { f as safeRealpathSync, i as isPathInside, p as safeStatSync } from "./path-BlG8lhgR.js";
import { f as shouldRejectHardlinkedPluginFiles, t as discoverOpenClawPlugins } from "./discovery-GEDtU7uI.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { o as resolveCompatibilityHostVersion } from "./version-CQfgAE7_.js";
import { t as isBlockedObjectKey } from "./prototype-keys-gIgii6VQ.js";
import { a as normalizeOptionalTrimmedStringList } from "./string-normalization-DiPHgdft.js";
import { a as loadBundleManifest } from "./bundle-manifest-s4nKSc4m.js";
import { c as resolvePluginActivationDecisionShared, i as normalizePluginsConfigWithResolver$1, l as toPluginActivationState, n as identityNormalizePluginId, r as isBundledChannelEnabledByChannelConfig$1, s as resolveMemorySlotDecisionShared, t as hasExplicitPluginConfig$1 } from "./config-normalization-shared-Ce2joeLa.js";
import { n as loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader-BvE-GqxR.js";
import { i as loadPluginManifest } from "./manifest-Cyo7Vmnr.js";
import { t as checkMinHostVersion } from "./min-host-version-Ceo2xu29.js";
import { c as resolveOfficialExternalPluginInstall, n as getOfficialExternalPluginCatalogEntryForPackage, r as getOfficialExternalPluginCatalogManifest, s as resolveOfficialExternalPluginId } from "./official-external-plugin-catalog-f6g4JsA2.js";
import fs from "node:fs";
import path from "node:path";
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
function resolvePluginSourcePath(sourcePath) {
	if (fs.existsSync(sourcePath)) return sourcePath;
	if (sourcePath.endsWith(".ts")) {
		const jsPath = sourcePath.slice(0, -3) + ".js";
		if (fs.existsSync(jsPath)) return jsPath;
	}
	return sourcePath;
}
function isPluginRootPath(params) {
	const resolvedTargetPath = path.resolve(params.targetPath);
	if (!isPathInside(path.resolve(params.rootPath), resolvedTargetPath)) return false;
	const targetRealPath = safeRealpathSync(resolvedTargetPath);
	if (!targetRealPath) return params.targetMustExist !== true;
	if (!isPathInside(params.rootRealPath, targetRealPath)) return false;
	if (params.rejectHardlinks === true) {
		const targetStat = safeStatSync(resolvedTargetPath);
		if (!targetStat || targetStat.nlink > 1) return false;
	}
	return true;
}
function resolveManifestPluginSourcePath(params) {
	const pushDiagnostic = () => {
		params.diagnostics.push({
			level: "warn",
			pluginId: sanitizeForLog(params.pluginId),
			source: sanitizeForLog(params.manifestPath),
			message: `plugin manifest ${params.entryName} must resolve inside the plugin root; ignoring entry`
		});
	};
	if (path.isAbsolute(params.entry)) {
		pushDiagnostic();
		return;
	}
	const rootPath = path.resolve(params.rootDir);
	const rootRealPath = safeRealpathSync(rootPath) ?? rootPath;
	const sourcePath = path.resolve(rootPath, params.entry);
	if (!isPluginRootPath({
		rootPath,
		targetPath: sourcePath,
		rootRealPath,
		rejectHardlinks: params.rejectHardlinks,
		targetMustExist: fs.existsSync(sourcePath)
	})) {
		pushDiagnostic();
		return;
	}
	const resolvedSourcePath = resolvePluginSourcePath(sourcePath);
	if (!isPluginRootPath({
		rootPath,
		targetPath: resolvedSourcePath,
		rootRealPath,
		rejectHardlinks: params.rejectHardlinks,
		targetMustExist: fs.existsSync(resolvedSourcePath)
	})) {
		pushDiagnostic();
		return;
	}
	return resolvedSourcePath;
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
function mergeContractLists(left, right) {
	const merged = [...left ?? [], ...right ?? []].map((value) => value.trim()).filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
	return merged.length > 0 ? merged : void 0;
}
function mergeManifestContracts(manifestContracts, catalogContracts) {
	if (!catalogContracts) return manifestContracts;
	const contracts = {};
	for (const key of [
		"embeddedExtensionFactories",
		"agentToolResultMiddleware",
		"externalAuthProviders",
		"embeddingProviders",
		"memoryEmbeddingProviders",
		"speechProviders",
		"realtimeTranscriptionProviders",
		"realtimeVoiceProviders",
		"mediaUnderstandingProviders",
		"documentExtractors",
		"imageGenerationProviders",
		"videoGenerationProviders",
		"musicGenerationProviders",
		"webContentExtractors",
		"webFetchProviders",
		"webSearchProviders",
		"migrationProviders",
		"gatewayMethodDispatch",
		"tools"
	]) {
		const merged = mergeContractLists(manifestContracts?.[key], catalogContracts[key]);
		if (merged) contracts[key] = merged;
	}
	return Object.keys(contracts).length > 0 ? contracts : void 0;
}
function mergeCatalogChannelConfigs(params) {
	if (!params.catalogChannelConfigs) return params.manifestChannelConfigs;
	const merged = Object.create(null);
	for (const [key, value] of Object.entries(params.catalogChannelConfigs)) if (!isBlockedObjectKey(key)) merged[key] = value;
	for (const [key, value] of Object.entries(params.manifestChannelConfigs ?? {})) if (!isBlockedObjectKey(key)) {
		const catalogValue = merged[key];
		merged[key] = catalogValue ? {
			...catalogValue,
			...value,
			schema: value.schema ?? catalogValue.schema,
			...catalogValue.uiHints || value.uiHints ? { uiHints: {
				...catalogValue.uiHints,
				...value.uiHints
			} } : {},
			...value.runtime ?? catalogValue.runtime ? { runtime: value.runtime ?? catalogValue.runtime } : {},
			...value.label ?? catalogValue.label ? { label: value.label ?? catalogValue.label } : {},
			...value.description ?? catalogValue.description ? { description: value.description ?? catalogValue.description } : {},
			...value.preferOver ?? catalogValue.preferOver ? { preferOver: value.preferOver ?? catalogValue.preferOver } : {},
			...value.commands ?? catalogValue.commands ? { commands: value.commands ?? catalogValue.commands } : {}
		} : value;
	}
	return Object.keys(merged).length > 0 ? merged : void 0;
}
function buildRecord(params) {
	const providerSourceEntry = params.manifest.providerCatalogEntry !== void 0 ? {
		entryName: "providerCatalogEntry",
		entry: params.manifest.providerCatalogEntry
	} : params.manifest.providerDiscoveryEntry !== void 0 ? {
		entryName: "providerDiscoveryEntry",
		entry: params.manifest.providerDiscoveryEntry
	} : void 0;
	const manifestChannelConfigs = params.candidate.origin === "bundled" && params.bundledChannelConfigCollector ? params.bundledChannelConfigCollector({
		pluginDir: params.candidate.packageDir ?? params.candidate.rootDir,
		manifest: params.manifest,
		packageManifest: params.candidate.packageManifest
	}) : params.manifest.channelConfigs;
	const officialCatalogManifest = params.candidate.origin !== "bundled" ? getOfficialExternalPluginCatalogManifest(getOfficialExternalPluginCatalogEntryForPackage(params.candidate.packageName) ?? {}) : void 0;
	const channelConfigs = mergePackageChannelMetaIntoChannelConfigs({
		channelConfigs: mergeCatalogChannelConfigs({
			manifestChannelConfigs,
			catalogChannelConfigs: officialCatalogManifest?.channelConfigs
		}),
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
		enabledByDefaultOnPlatforms: params.manifest.enabledByDefaultOnPlatforms,
		autoEnableWhenConfiguredProviders: params.manifest.autoEnableWhenConfiguredProviders,
		legacyPluginIds: params.manifest.legacyPluginIds,
		format: params.candidate.format ?? "openclaw",
		bundleFormat: params.candidate.bundleFormat,
		kind: params.manifest.kind,
		channels: params.manifest.channels ?? [],
		providers: params.manifest.providers ?? [],
		providerDiscoverySource: providerSourceEntry ? resolveManifestPluginSourcePath({
			rootDir: params.candidate.rootDir,
			manifestPath: params.manifestPath,
			pluginId: params.manifest.id,
			entryName: providerSourceEntry.entryName,
			entry: providerSourceEntry.entry,
			rejectHardlinks: params.rejectHardlinks,
			diagnostics: params.diagnostics
		}) : void 0,
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
		trustedOfficialInstall: params.trustedOfficialInstall === true ? true : void 0,
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
		contracts: mergeManifestContracts(params.manifest.contracts, officialCatalogManifest?.contracts),
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
		activation: params.manifest.activation,
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
	const configuredEntry = params.normalized?.entries[params.record.id];
	if (params.normalized?.enabled === false || configuredEntry?.enabled === false || params.normalized?.deny.includes(params.record.id) || params.normalized?.allow.length && !params.normalized.allow.includes(params.record.id)) return;
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
		message: `channel plugin manifest declares ${safeMissingChannels.join(", ")} without channelConfigs metadata; add openclaw.plugin.json#channelConfigs so config schema and setup surfaces work before runtime loads. Channels without channelConfigs still appear in channel listings, but setup UI may be limited.`
	});
}
function pushManifestCompatibilityDiagnostics(params) {
	pushProviderAuthEnvVarsCompatDiagnostic(params);
	pushNonBundledChannelConfigDescriptorDiagnostic(params);
}
function dedupePluginDiagnostics(diagnostics) {
	const seen = /* @__PURE__ */ new Set();
	const deduped = [];
	for (const diagnostic of diagnostics) {
		const key = JSON.stringify([
			diagnostic.level,
			diagnostic.pluginId ?? "",
			diagnostic.message
		]);
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(diagnostic);
	}
	return deduped;
}
function matchesInstalledPluginRecord(params) {
	if (params.candidate.origin !== "global" && params.candidate.origin !== "config") return false;
	const record = params.installRecords[params.pluginId];
	if (!record) return false;
	const resolvedCandidateSource = resolveUserPath(params.candidate.source, params.env);
	const candidateSource = safeRealpathSync(resolvedCandidateSource) ?? resolvedCandidateSource;
	const trackedPaths = [record.installPath, record.sourcePath].filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => {
		const resolved = resolveUserPath(entry, params.env);
		return safeRealpathSync(resolved) ?? resolved;
	});
	if (trackedPaths.length === 0) return false;
	return trackedPaths.some((trackedPath) => {
		return candidateSource === trackedPath || isPathInside(trackedPath, candidateSource);
	});
}
function npmSpecMatchesPackage(value, packageName) {
	const normalized = value?.trim();
	if (!normalized) return false;
	if (normalized === packageName) return true;
	return normalized.startsWith(`${packageName}@`);
}
function isTrustedOfficialPluginInstall(params) {
	if (params.candidate.origin !== "global" && params.candidate.origin !== "config" || !matchesInstalledPluginRecord({
		pluginId: params.pluginId,
		candidate: params.candidate,
		env: params.env,
		installRecords: params.installRecords
	})) return false;
	const packageName = params.candidate.packageName?.trim();
	if (!packageName) return false;
	const catalogEntry = getOfficialExternalPluginCatalogEntryForPackage(packageName);
	if (!catalogEntry || resolveOfficialExternalPluginId(catalogEntry) !== params.pluginId) return false;
	const officialInstall = resolveOfficialExternalPluginInstall(catalogEntry);
	const installRecord = params.installRecords[params.pluginId];
	if (!installRecord) return false;
	if (installRecord.source === "npm" && officialInstall?.npmSpec === packageName && [
		installRecord.resolvedName,
		installRecord.spec,
		installRecord.resolvedSpec,
		params.candidate.packageName
	].some((value) => npmSpecMatchesPackage(value, packageName))) return true;
	if (installRecord.source === "clawhub" && officialInstall?.clawhubSpec && installRecord.clawhubChannel === "official" && (installRecord.clawhubPackage === packageName || installRecord.spec === officialInstall.clawhubSpec || installRecord.resolvedSpec === officialInstall.clawhubSpec)) return true;
	return false;
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
function isSameGlobalPackageDuplicate(left, right) {
	if (left.origin !== "global" || right.origin !== "global") return false;
	const leftPackageName = normalizeOptionalString(left.packageName);
	const rightPackageName = normalizeOptionalString(right.packageName);
	if (!leftPackageName || leftPackageName !== rightPackageName) return false;
	const leftPackageVersion = normalizeOptionalString(left.packageVersion);
	const rightPackageVersion = normalizeOptionalString(right.packageVersion);
	return Boolean(leftPackageVersion && rightPackageVersion && leftPackageVersion === rightPackageVersion);
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
	} : params.discovery ?? discoverOpenClawPlugins({
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
		const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
			origin: candidate.origin,
			rootDir: candidate.rootDir,
			env,
			realpathCache
		});
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
			diagnostics,
			rejectHardlinks,
			schemaCacheKey,
			configSchema,
			trustedOfficialInstall: isTrustedOfficialPluginInstall({
				pluginId: manifest.id,
				candidate,
				env,
				installRecords: getInstallRecords()
			}),
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
						diagnostics,
						normalized
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
					diagnostics,
					normalized
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
			if (isSameGlobalPackageDuplicate(candidate, existing.candidate)) continue;
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
			diagnostics,
			normalized
		});
	}
	return {
		plugins: records,
		diagnostics: dedupePluginDiagnostics(diagnostics)
	};
}
//#endregion
export { resolveMemorySlotDecision as a, resolveEffectivePluginActivationState as i, hasExplicitPluginConfig as n, normalizePluginsConfigWithResolver as r, loadPluginManifestRegistry as t };
