import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { c as readLegacyNpmPluginDeclaration } from "./discovery-GEDtU7uI.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import { a as resolveDefaultPluginNpmDir, o as resolvePluginInstallDir, r as resolveDefaultPluginExtensionsDir } from "./install-paths-B32RY-Gz.js";
import { f as loadInstalledPluginIndex } from "./installed-plugin-index-store-C1Oen9wR.js";
import { t as loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-record-reader-BvE-GqxR.js";
import { t as parseClawHubPluginSpec } from "./clawhub-spec-J_MJr4Sl.js";
import { i as isOpenClawOrgNpmSpec, s as parseRegistryNpmSpec } from "./npm-registry-spec-BwaWslDm.js";
import { a as listOfficialExternalPluginCatalogEntries, c as resolveOfficialExternalPluginInstall, l as resolveOfficialExternalPluginLabel, s as resolveOfficialExternalPluginId } from "./official-external-plugin-catalog-f6g4JsA2.js";
import { t as buildNpmResolutionInstallFields } from "./installs-j3Id-apF.js";
import { s as writePersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records-BrXfmg6n.js";
import { n as resolveWebSearchInstallCatalogEntry } from "./web-search-install-catalog-CbZkTyiv.js";
import { s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-LkT7g78Y.js";
import { i as listPotentialConfiguredChannelIds, r as listExplicitlyDisabledChannelIdsForConfig } from "./config-presence-DiJ4UoDg.js";
import { h as resolveConfiguredChannelPresencePolicy } from "./channel-plugin-ids-nB-ga3MN.js";
import { a as installPluginFromNpmSpec } from "./install-BG7jqqYt.js";
import { r as installPluginFromClawHub, t as CLAWHUB_INSTALL_ERROR_CODE } from "./clawhub-CFGNynZy.js";
import { r as listChannelPluginCatalogEntries } from "./catalog-Cw2Qtjnc.js";
import { l as resolveRegistryUpdateChannel, s as normalizeUpdateChannel } from "./update-channels-f-ieRme5.js";
import { t as buildClawHubPluginInstallRecordFields } from "./clawhub-install-records-Dv-7kghM.js";
import { n as resolveNpmInstallSpecsForUpdateChannel, t as resolveClawHubInstallSpecsForUpdateChannel } from "./install-channel-specs-BOF5k8F8.js";
import { i as updateNpmInstalledPlugins } from "./update-B9jZfD-S.js";
import { n as collectConfiguredRuntimePluginIds, t as CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES } from "./configured-runtime-plugin-installs-D_FZggJS.js";
import { t as resolveProviderInstallCatalogEntries } from "./provider-install-catalog-BboFtl6M.js";
import { c as shouldDeferConfiguredPluginInstallRepair, i as isLegacyPackageUpdateDoctorPass, o as isPostCoreConvergencePass } from "./update-phase-2jBtHxsn.js";
import { t as asObjectRecord } from "./object-BsiS9JXh.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
//#region src/commands/doctor/shared/missing-configured-plugin-install.ts
const MISSING_CHANNEL_CONFIG_DESCRIPTOR_DIAGNOSTIC = "without channelConfigs metadata";
const REPAIRABLE_PACKAGE_ENTRY_DIAGNOSTIC_MARKERS = [
	"extension entry escapes package directory",
	"extension entry unreadable",
	"requires compiled runtime output"
];
function shouldFallbackClawHubToNpm(params) {
	if (!isOpenClawOrgNpmSpec(params.npmSpec)) return false;
	return params.result.code === CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND || params.result.code === CLAWHUB_INSTALL_ERROR_CODE.VERSION_NOT_FOUND || params.result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_DOWNLOAD_UNAVAILABLE || params.result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE;
}
function resolveCandidateClawHubSpec(install) {
	const explicit = install.clawhubSpec?.trim();
	if (explicit) return explicit;
}
function addConfiguredPluginId(ids, value) {
	if (typeof value !== "string") return;
	const pluginId = value.trim();
	if (pluginId) ids.add(pluginId);
}
function addConfiguredAgentRuntimePluginIds(ids, cfg, env) {
	for (const runtime of collectConfiguredRuntimePluginIds(cfg, env ?? process.env, {
		includeEnvRuntime: false,
		includeLegacyAgentRuntimes: false
	})) addConfiguredPluginId(ids, runtime);
}
function collectConfiguredPluginIds(cfg, env) {
	const ids = /* @__PURE__ */ new Set();
	const plugins = asObjectRecord(cfg.plugins);
	if (plugins?.enabled === false) return ids;
	const entries = asObjectRecord(plugins?.entries);
	for (const [pluginId, entry] of Object.entries(entries ?? {})) {
		if (asObjectRecord(entry)?.enabled === false) continue;
		addConfiguredPluginId(ids, pluginId);
	}
	const searchProvider = cfg.tools?.web?.search?.provider;
	if (cfg.tools?.web?.search?.enabled !== false && typeof searchProvider === "string") {
		const installEntry = resolveWebSearchInstallCatalogEntry({ providerId: searchProvider });
		if (installEntry?.pluginId) ids.add(installEntry.pluginId);
	}
	addConfiguredAgentRuntimePluginIds(ids, cfg, env);
	return ids;
}
function collectBlockedPluginIds(cfg) {
	const ids = /* @__PURE__ */ new Set();
	const deny = cfg.plugins?.deny;
	if (Array.isArray(deny)) {
		for (const pluginId of deny) if (typeof pluginId === "string" && pluginId.trim()) ids.add(pluginId.trim());
	}
	const entries = asObjectRecord(cfg.plugins?.entries);
	for (const [pluginId, entry] of Object.entries(entries ?? {})) if (pluginId.trim() && asObjectRecord(entry)?.enabled === false) ids.add(pluginId.trim());
	return ids;
}
function collectConfiguredChannelIds(cfg, env) {
	const ids = /* @__PURE__ */ new Set();
	if (asObjectRecord(cfg.plugins)?.enabled === false) return ids;
	const disabled = new Set(listExplicitlyDisabledChannelIdsForConfig(cfg));
	const candidateChannelIds = listChannelPluginCatalogEntries({
		env,
		excludeWorkspace: true
	}).map((entry) => entry.id);
	for (const channelId of listPotentialConfiguredChannelIds(cfg, env, {
		channelIds: candidateChannelIds,
		includePersistedAuthState: false
	})) {
		const normalized = channelId.trim();
		if (normalized && !disabled.has(normalized.toLowerCase())) ids.add(normalized);
	}
	return ids;
}
function collectEffectiveConfiguredChannelOwnerPluginIds(params) {
	const owners = /* @__PURE__ */ new Map();
	const configuredChannelIds = new Set([...params.configuredChannelIds].map((channelId) => normalizeOptionalLowercaseString(channelId)).filter((channelId) => Boolean(channelId)));
	if (configuredChannelIds.size === 0) return owners;
	for (const entry of resolveConfiguredChannelPresencePolicy({
		config: params.cfg,
		env: params.env,
		includePersistedAuthState: false,
		manifestRecords: params.snapshot.plugins
	})) {
		if (!entry.effective || !configuredChannelIds.has(entry.channelId)) continue;
		const pluginIds = new Set(entry.pluginIds);
		if (pluginIds.size > 0) owners.set(entry.channelId, pluginIds);
	}
	return owners;
}
function collectDownloadableInstallCandidates(params) {
	const configuredPluginIds = params.configuredPluginIds ?? collectConfiguredPluginIds(params.cfg, params.env);
	const configuredChannelIds = params.configuredChannelIds ?? collectConfiguredChannelIds(params.cfg, params.env);
	const candidates = /* @__PURE__ */ new Map();
	for (const entry of listChannelPluginCatalogEntries({
		env: params.env,
		excludeWorkspace: true
	})) {
		if (entry.origin === "bundled") continue;
		const pluginId = entry.pluginId ?? entry.id;
		const channelId = normalizeOptionalLowercaseString(entry.id);
		if (params.blockedPluginIds?.has(pluginId)) continue;
		const selectedOnlyByChannel = !params.missingPluginIds.has(pluginId) && !configuredPluginIds.has(pluginId) && (channelId ? configuredChannelIds.has(channelId) : configuredChannelIds.has(entry.id));
		const configuredChannelOwnerPluginIds = channelId ? params.configuredChannelOwnerPluginIds?.get(channelId) : void 0;
		if (selectedOnlyByChannel && configuredChannelOwnerPluginIds && configuredChannelOwnerPluginIds.size > 0 && !configuredChannelOwnerPluginIds.has(pluginId)) continue;
		if (!params.missingPluginIds.has(pluginId) && !configuredPluginIds.has(pluginId) && !configuredChannelIds.has(entry.id)) continue;
		const npmSpec = entry.install.npmSpec?.trim();
		const clawhubSpec = resolveCandidateClawHubSpec(entry.install);
		if (!npmSpec && !clawhubSpec) continue;
		candidates.set(pluginId, {
			pluginId,
			label: entry.meta.label,
			...npmSpec ? { npmSpec } : {},
			...clawhubSpec ? { clawhubSpec } : {},
			...entry.install.expectedIntegrity ? { expectedIntegrity: entry.install.expectedIntegrity } : {},
			...entry.trustedSourceLinkedOfficialInstall ? { trustedSourceLinkedOfficialInstall: true } : {},
			...entry.install.defaultChoice ? { defaultChoice: entry.install.defaultChoice } : {}
		});
	}
	for (const entry of resolveProviderInstallCatalogEntries({
		config: params.cfg,
		env: params.env,
		includeUntrustedWorkspacePlugins: false
	})) {
		if (!configuredPluginIds.has(entry.pluginId) && !params.missingPluginIds.has(entry.pluginId)) continue;
		if (params.blockedPluginIds?.has(entry.pluginId)) continue;
		const npmSpec = entry.install.npmSpec?.trim();
		const clawhubSpec = resolveCandidateClawHubSpec(entry.install);
		if (!npmSpec && !clawhubSpec) continue;
		candidates.set(entry.pluginId, {
			pluginId: entry.pluginId,
			label: entry.label,
			...npmSpec ? { npmSpec } : {},
			...clawhubSpec ? { clawhubSpec } : {},
			...entry.install.expectedIntegrity ? { expectedIntegrity: entry.install.expectedIntegrity } : {},
			...entry.origin === "bundled" ? { trustedSourceLinkedOfficialInstall: true } : {},
			...entry.install.defaultChoice ? { defaultChoice: entry.install.defaultChoice } : {}
		});
	}
	for (const entry of listOfficialExternalPluginCatalogEntries()) {
		const pluginId = resolveOfficialExternalPluginId(entry);
		if (!pluginId || candidates.has(pluginId) || params.blockedPluginIds?.has(pluginId)) continue;
		if (!configuredPluginIds.has(pluginId) && !params.missingPluginIds.has(pluginId)) continue;
		const install = resolveOfficialExternalPluginInstall(entry);
		if (!install) continue;
		const npmSpec = install.npmSpec?.trim();
		const clawhubSpec = resolveCandidateClawHubSpec(install);
		if (!npmSpec && !clawhubSpec) continue;
		candidates.set(pluginId, {
			pluginId,
			label: resolveOfficialExternalPluginLabel(entry),
			...npmSpec ? { npmSpec } : {},
			...clawhubSpec ? { clawhubSpec } : {},
			...install.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {},
			trustedSourceLinkedOfficialInstall: true,
			...install.defaultChoice ? { defaultChoice: install.defaultChoice } : {}
		});
	}
	for (const entry of CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES) {
		if (!configuredPluginIds.has(entry.pluginId) && !params.missingPluginIds.has(entry.pluginId)) continue;
		if (params.blockedPluginIds?.has(entry.pluginId)) continue;
		if (!candidates.has(entry.pluginId)) candidates.set(entry.pluginId, entry);
	}
	for (const candidate of collectLegacyNpmDeclarationInstallCandidates({
		cfg: params.cfg,
		env: params.env,
		configuredPluginIds,
		missingPluginIds: params.missingPluginIds,
		blockedPluginIds: params.blockedPluginIds
	})) if (!candidates.has(candidate.pluginId)) candidates.set(candidate.pluginId, candidate);
	return [...candidates.values()].toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
}
function addLegacyNpmDeclarationInstallCandidate(params) {
	const declaration = readLegacyNpmPluginDeclaration(params.pluginDir);
	if (!declaration) return;
	if (params.blockedPluginIds?.has(declaration.pluginId) || !params.configuredPluginIds.has(declaration.pluginId) && !params.missingPluginIds.has(declaration.pluginId)) return;
	params.candidates.set(declaration.pluginId, {
		pluginId: declaration.pluginId,
		label: declaration.pluginId,
		npmSpec: declaration.npmSpec,
		defaultChoice: "npm"
	});
}
function collectLegacyNpmDeclarationInstallCandidates(params) {
	const candidates = /* @__PURE__ */ new Map();
	const env = params.env ?? process.env;
	const loadPaths = params.cfg.plugins?.load?.paths;
	if (Array.isArray(loadPaths)) for (const rawPath of loadPaths) {
		if (typeof rawPath !== "string" || !rawPath.trim()) continue;
		addLegacyNpmDeclarationInstallCandidate({
			candidates,
			pluginDir: resolveUserPath(rawPath, env),
			configuredPluginIds: params.configuredPluginIds,
			missingPluginIds: params.missingPluginIds,
			blockedPluginIds: params.blockedPluginIds
		});
	}
	const extensionsDir = resolveDefaultPluginExtensionsDir(env);
	const configuredOrMissingPluginIds = new Set([...params.configuredPluginIds, ...params.missingPluginIds]);
	for (const pluginId of configuredOrMissingPluginIds) try {
		addLegacyNpmDeclarationInstallCandidate({
			candidates,
			pluginDir: resolvePluginInstallDir(pluginId, extensionsDir),
			configuredPluginIds: params.configuredPluginIds,
			missingPluginIds: params.missingPluginIds,
			blockedPluginIds: params.blockedPluginIds
		});
	} catch {
		continue;
	}
	return [...candidates.values()].toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
}
function collectUpdateDeferredPluginIds(params) {
	const pluginIds = new Set(params.configuredPluginIds);
	for (const candidate of collectDownloadableInstallCandidates({
		cfg: params.cfg,
		env: params.env,
		missingPluginIds: /* @__PURE__ */ new Set(),
		configuredPluginIds: params.configuredPluginIds,
		configuredChannelIds: params.configuredChannelIds,
		configuredChannelOwnerPluginIds: params.configuredChannelOwnerPluginIds,
		blockedPluginIds: params.blockedPluginIds
	})) pluginIds.add(candidate.pluginId);
	return pluginIds;
}
function collectConfiguredPluginIdsWithMissingChannelConfigDescriptors(params) {
	const stalePluginIds = /* @__PURE__ */ new Set();
	const pluginsById = new Map(params.snapshot.plugins.map((plugin) => [plugin.id, plugin]));
	for (const diagnostic of params.snapshot.diagnostics) {
		const pluginId = diagnostic.pluginId?.trim();
		if (!pluginId || !diagnostic.message.includes(MISSING_CHANNEL_CONFIG_DESCRIPTOR_DIAGNOSTIC)) continue;
		const ownsConfiguredChannel = pluginsById.get(pluginId)?.channels.some((channelId) => params.configuredChannelIds.has(channelId));
		if (params.configuredPluginIds.has(pluginId) || ownsConfiguredChannel) stalePluginIds.add(pluginId);
	}
	return stalePluginIds;
}
function collectInstalledPluginIdsWithRepairablePackageDiagnostics(params) {
	const pluginIds = /* @__PURE__ */ new Set();
	for (const diagnostic of params.snapshot.diagnostics) {
		const pluginId = diagnostic.pluginId?.trim();
		if (!pluginId || !Object.hasOwn(params.installRecords, pluginId)) continue;
		if (REPAIRABLE_PACKAGE_ENTRY_DIAGNOSTIC_MARKERS.some((marker) => diagnostic.message.includes(marker))) pluginIds.add(pluginId);
	}
	return pluginIds;
}
function isConfiguredPluginRepairTarget(params) {
	if (params.configuredPluginIds.has(params.pluginId)) return true;
	if (params.configuredChannelIds.has(params.pluginId)) return true;
	for (const ownerIds of params.configuredChannelOwnerPluginIds.values()) if (ownerIds.has(params.pluginId)) return true;
	return false;
}
function collectOfficialReplacementInstallCandidates(params) {
	const repairableConfiguredPluginIds = new Set([...params.repairablePluginIds].filter((pluginId) => isConfiguredPluginRepairTarget({
		pluginId,
		configuredPluginIds: params.configuredPluginIds,
		configuredChannelIds: params.configuredChannelIds,
		configuredChannelOwnerPluginIds: params.configuredChannelOwnerPluginIds
	})));
	if (repairableConfiguredPluginIds.size === 0) return /* @__PURE__ */ new Map();
	const candidates = collectDownloadableInstallCandidates({
		cfg: params.cfg,
		env: params.env,
		missingPluginIds: repairableConfiguredPluginIds,
		configuredPluginIds: params.configuredPluginIds,
		configuredChannelIds: params.configuredChannelIds,
		configuredChannelOwnerPluginIds: params.configuredChannelOwnerPluginIds,
		blockedPluginIds: params.blockedPluginIds
	});
	return new Map(candidates.filter((candidate) => repairableConfiguredPluginIds.has(candidate.pluginId) && candidate.trustedSourceLinkedOfficialInstall).map((candidate) => [candidate.pluginId, candidate]));
}
function forceNpmInstallRecordRepair(record) {
	if (record.source !== "npm") return record;
	const next = { ...record };
	delete next.resolvedSpec;
	delete next.resolvedVersion;
	return next;
}
function isInstalledRecordMissingOnDisk(record, env) {
	const installPath = record?.installPath?.trim();
	if (!installPath) return true;
	const resolved = resolveUserPath(installPath, env);
	return !existsSync(path.join(resolved, "package.json"));
}
function pathsEqual(left, right) {
	return path.resolve(left) === path.resolve(right);
}
function resolveNpmPackageInstallPath(params) {
	return path.join(params.npmRoot, "node_modules", ...params.packageName.split("/"));
}
function collectCandidateOfficialPackageNames(candidate) {
	const names = /* @__PURE__ */ new Set();
	const npmName = candidate.npmSpec ? parseRegistryNpmSpec(candidate.npmSpec)?.name : void 0;
	const clawhubName = candidate.clawhubSpec ? parseClawHubPluginSpec(candidate.clawhubSpec)?.name : void 0;
	if (npmName) names.add(npmName);
	if (clawhubName) names.add(clawhubName);
	return names;
}
function collectInstalledRecordPackageNames(record) {
	const names = /* @__PURE__ */ new Set();
	if (record.source === "npm") {
		const specName = record.spec ? parseRegistryNpmSpec(record.spec)?.name : void 0;
		const resolvedSpecName = record.resolvedSpec ? parseRegistryNpmSpec(record.resolvedSpec)?.name : void 0;
		for (const value of [
			record.resolvedName,
			specName,
			resolvedSpecName
		]) if (value) names.add(value);
	}
	if (record.source === "clawhub") {
		const specName = record.spec ? parseClawHubPluginSpec(record.spec)?.name : void 0;
		for (const value of [record.clawhubPackage, specName]) if (value) names.add(value);
	}
	return names;
}
function isTrustedOfficialInstallRecordForCandidate(params) {
	const record = params.record;
	if (!record) return false;
	if (record.source !== "npm" && record.source !== "clawhub") return false;
	if (record.source === "clawhub" && record.clawhubChannel !== "official") return false;
	const candidatePackageNames = collectCandidateOfficialPackageNames(params.candidate);
	if (candidatePackageNames.size === 0) return false;
	for (const installedPackageName of collectInstalledRecordPackageNames(record)) if (candidatePackageNames.has(installedPackageName)) return true;
	return false;
}
function resolveSafeBrokenOfficialInstallRemovalPath(params) {
	const installPath = params.record?.installPath?.trim();
	if (!installPath) return null;
	const resolvedInstallPath = resolveUserPath(installPath, params.env);
	try {
		const extensionsDir = resolveDefaultPluginExtensionsDir(params.env);
		if (pathsEqual(resolvedInstallPath, resolvePluginInstallDir(params.pluginId, extensionsDir))) return resolvedInstallPath;
	} catch {}
	const parsedNpmSpec = params.candidate.npmSpec ? parseRegistryNpmSpec(params.candidate.npmSpec) : null;
	if (!parsedNpmSpec?.name) return null;
	return pathsEqual(resolvedInstallPath, resolveNpmPackageInstallPath({
		packageName: parsedNpmSpec.name,
		npmRoot: resolveDefaultPluginNpmDir(params.env)
	})) ? resolvedInstallPath : null;
}
function recordMatchesBundledPackage(record, bundled) {
	const packageName = bundled.packageName?.trim() || bundled.name?.trim();
	if (!packageName) return false;
	if (record.source === "npm") return [
		record.spec,
		record.resolvedName,
		record.resolvedSpec
	].some((value) => recordNpmPackageName(value) === packageName);
	if (record.source === "clawhub") return [record.clawhubPackage, record.spec].some((value) => recordClawHubPackageName(value) === packageName);
	return false;
}
function recordNpmPackageName(value) {
	const trimmed = value?.trim();
	return trimmed ? parseRegistryNpmSpec(trimmed)?.name : void 0;
}
function recordClawHubPackageName(value) {
	const trimmed = value?.trim();
	if (!trimmed) return;
	return parseClawHubPluginSpec(trimmed)?.name ?? trimmed;
}
async function installCandidate(params) {
	const { candidate } = params;
	const extensionsDir = resolveDefaultPluginExtensionsDir(params.env);
	const changes = [];
	const clawhubSpecs = candidate.clawhubSpec ? resolveClawHubInstallSpecsForUpdateChannel({
		spec: candidate.clawhubSpec,
		updateChannel: params.updateChannel
	}) : null;
	const npmSpecs = candidate.npmSpec ? resolveNpmInstallSpecsForUpdateChannel({
		spec: candidate.npmSpec,
		updateChannel: params.updateChannel
	}) : null;
	const clawhubInstallSpec = clawhubSpecs?.installSpec ?? candidate.clawhubSpec;
	const npmInstallSpec = npmSpecs?.installSpec ?? candidate.npmSpec;
	const npmDir = resolveDefaultPluginNpmDir(params.env);
	const existingClawHubPackagePath = clawhubInstallSpec ? resolveExistingCandidateClawHubPackagePath({
		candidate,
		extensionsDir
	}) : null;
	const existingNpmPackagePath = npmInstallSpec ? resolveExistingCandidateNpmPackagePath({
		candidate,
		npmDir
	}) : null;
	const existingNpmPackageVersion = existingNpmPackagePath ? await readNpmPackageVersion(existingNpmPackagePath) : void 0;
	if (existingNpmPackagePath && existingNpmPackageVersion && npmInstallSpec && params.mode !== "update" && isPostCoreConvergencePass(params.env)) return await adoptExistingNpmPackage({
		candidate,
		records: params.records,
		npmInstallSpec,
		npmRecordSpec: npmSpecs?.recordSpec ?? npmInstallSpec,
		packagePath: existingNpmPackagePath,
		version: existingNpmPackageVersion
	});
	if (clawhubInstallSpec && !existingNpmPackagePath && !(params.preferNpm && npmInstallSpec) && candidate.defaultChoice !== "npm") {
		const clawhubResult = await installPluginFromClawHub({
			spec: clawhubInstallSpec,
			extensionsDir,
			env: params.env,
			expectedPluginId: candidate.pluginId,
			mode: params.mode === "update" || existingClawHubPackagePath ? "update" : "install"
		});
		if (clawhubResult.ok) {
			const pluginId = clawhubResult.pluginId;
			return {
				records: {
					...params.records,
					[pluginId]: {
						...buildClawHubPluginInstallRecordFields(clawhubResult.clawhub),
						spec: clawhubSpecs?.recordSpec ?? clawhubInstallSpec,
						installPath: clawhubResult.targetDir,
						installedAt: (/* @__PURE__ */ new Date()).toISOString()
					}
				},
				changes: [`Installed missing configured plugin "${pluginId}" from ${clawhubInstallSpec}.`],
				warnings: []
			};
		}
		if (!npmInstallSpec || !shouldFallbackClawHubToNpm({
			result: clawhubResult,
			npmSpec: npmInstallSpec
		})) return {
			records: params.records,
			changes: [],
			warnings: [`Failed to install missing configured plugin "${candidate.pluginId}" from ${clawhubInstallSpec}: ${clawhubResult.error}`],
			failedPluginId: candidate.pluginId
		};
		changes.push(`ClawHub ${clawhubInstallSpec} unavailable for "${candidate.pluginId}"; falling back to npm ${npmInstallSpec}.`);
	}
	if (!npmInstallSpec) return {
		records: params.records,
		changes: [],
		warnings: [`Failed to install missing configured plugin "${candidate.pluginId}": missing npm spec.`],
		failedPluginId: candidate.pluginId
	};
	const npmInstallMode = params.mode === "update" || existingNpmPackagePath ? "update" : "install";
	let result = await installPluginFromNpmSpec({
		spec: npmInstallSpec,
		extensionsDir,
		npmDir,
		expectedPluginId: candidate.pluginId,
		expectedIntegrity: candidate.expectedIntegrity,
		...candidate.trustedSourceLinkedOfficialInstall ? { trustedSourceLinkedOfficialInstall: true } : {},
		mode: npmInstallMode
	});
	if (!result.ok && npmInstallMode === "install" && isPluginAlreadyExistsError(result.error)) result = await installPluginFromNpmSpec({
		spec: npmInstallSpec,
		extensionsDir,
		npmDir,
		expectedPluginId: candidate.pluginId,
		expectedIntegrity: candidate.expectedIntegrity,
		...candidate.trustedSourceLinkedOfficialInstall ? { trustedSourceLinkedOfficialInstall: true } : {},
		mode: "update"
	});
	if (!result.ok) return {
		records: params.records,
		changes: [],
		warnings: [`Failed to install missing configured plugin "${candidate.pluginId}" from ${npmInstallSpec}: ${result.error}`],
		failedPluginId: candidate.pluginId
	};
	const pluginId = result.pluginId;
	return {
		records: {
			...params.records,
			[pluginId]: {
				source: "npm",
				spec: npmSpecs?.recordSpec ?? npmInstallSpec,
				installPath: result.targetDir,
				version: result.version,
				installedAt: (/* @__PURE__ */ new Date()).toISOString(),
				...buildNpmResolutionInstallFields(result.npmResolution)
			}
		},
		changes: [...changes, `Installed missing configured plugin "${pluginId}" from ${npmInstallSpec}.`],
		warnings: []
	};
}
function isPluginAlreadyExistsError(error) {
	return /\bplugin already exists:/.test(error);
}
function resolveExistingCandidateNpmPackagePath(params) {
	const npmName = params.candidate.npmSpec ? parseRegistryNpmSpec(params.candidate.npmSpec)?.name : void 0;
	if (!npmName) return null;
	const packagePath = resolveNpmPackageInstallPath({
		packageName: npmName,
		npmRoot: params.npmDir
	});
	return existsSync(packagePath) ? packagePath : null;
}
function resolveExistingCandidateClawHubPackagePath(params) {
	try {
		const packagePath = resolvePluginInstallDir(params.candidate.pluginId, params.extensionsDir);
		return existsSync(packagePath) ? packagePath : null;
	} catch {
		return null;
	}
}
async function readNpmPackageVersion(packagePath) {
	try {
		const parsed = JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf-8"));
		return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : void 0;
	} catch {
		return;
	}
}
async function adoptExistingNpmPackage(params) {
	const npmName = parseRegistryNpmSpec(params.npmInstallSpec)?.name;
	return {
		records: {
			...params.records,
			[params.candidate.pluginId]: {
				source: "npm",
				spec: params.npmRecordSpec,
				installPath: params.packagePath,
				installedAt: (/* @__PURE__ */ new Date()).toISOString(),
				version: params.version,
				resolvedVersion: params.version,
				...npmName ? { resolvedName: npmName } : {},
				...npmName ? { resolvedSpec: `${npmName}@${params.version}` } : {}
			}
		},
		changes: [`Repaired missing configured plugin "${params.candidate.pluginId}" from existing npm payload ${params.npmInstallSpec}.`],
		warnings: []
	};
}
async function repairMissingConfiguredPluginInstalls(params) {
	return repairMissingPluginInstalls({
		cfg: params.cfg,
		env: params.env,
		pluginIds: collectConfiguredPluginIds(params.cfg, params.env),
		channelIds: collectConfiguredChannelIds(params.cfg, params.env),
		blockedPluginIds: collectBlockedPluginIds(params.cfg),
		...params.baselineRecords ? { baselineRecords: params.baselineRecords } : {}
	});
}
async function repairMissingPluginInstallsForIds(params) {
	return repairMissingPluginInstalls({
		cfg: params.cfg,
		env: params.env,
		pluginIds: new Set([...params.pluginIds].map((pluginId) => pluginId.trim()).filter((pluginId) => pluginId)),
		channelIds: new Set([...params.channelIds ?? []].map((channelId) => channelId.trim()).filter((channelId) => channelId)),
		blockedPluginIds: new Set([...params.blockedPluginIds ?? []].map((pluginId) => pluginId.trim()).filter((pluginId) => pluginId)),
		...params.baselineRecords ? { baselineRecords: params.baselineRecords } : {}
	});
}
async function repairMissingPluginInstalls(params) {
	const env = params.env ?? process.env;
	const snapshot = loadManifestMetadataSnapshot({
		config: params.cfg,
		env
	});
	const currentBundledPlugins = loadInstalledPluginIndex({
		config: params.cfg,
		env,
		installRecords: {}
	}).plugins.filter((plugin) => plugin.origin === "bundled");
	const knownIds = new Set([...snapshot.plugins.map((plugin) => plugin.id), ...currentBundledPlugins.map((plugin) => plugin.pluginId)]);
	const configuredChannelOwnerPluginIds = collectEffectiveConfiguredChannelOwnerPluginIds({
		cfg: params.cfg,
		env,
		snapshot,
		configuredChannelIds: params.channelIds
	});
	const bundledPluginsById = new Map([...snapshot.plugins.filter((plugin) => plugin.origin === "bundled").map((plugin) => [plugin.id, plugin]), ...currentBundledPlugins.map((plugin) => [plugin.pluginId, { packageName: plugin.packageName }])]);
	const configuredPluginIdsWithStaleDescriptors = collectConfiguredPluginIdsWithMissingChannelConfigDescriptors({
		snapshot,
		configuredPluginIds: params.pluginIds,
		configuredChannelIds: params.channelIds
	});
	const records = params.baselineRecords ?? await loadInstalledPluginIndexInstallRecords({ env });
	const installedPluginIdsWithRepairablePackageDiagnostics = collectInstalledPluginIdsWithRepairablePackageDiagnostics({
		snapshot,
		installRecords: records
	});
	const officialReplacementInstallCandidates = collectOfficialReplacementInstallCandidates({
		cfg: params.cfg,
		env,
		repairablePluginIds: installedPluginIdsWithRepairablePackageDiagnostics,
		configuredPluginIds: params.pluginIds,
		configuredChannelIds: params.channelIds,
		configuredChannelOwnerPluginIds,
		blockedPluginIds: params.blockedPluginIds
	});
	const officialReplacementPluginIds = new Set(officialReplacementInstallCandidates.keys());
	const changes = [];
	const warnings = [];
	const failedPluginIds = /* @__PURE__ */ new Set();
	const deferredPluginIds = /* @__PURE__ */ new Set();
	const updateChannel = resolveRegistryUpdateChannel({
		configChannel: normalizeUpdateChannel(params.cfg.update?.channel),
		currentVersion: VERSION
	});
	const preferNpmInstalls = isLegacyPackageUpdateDoctorPass(env);
	let nextRecords = records;
	for (const [pluginId, record] of Object.entries(records)) {
		const bundled = bundledPluginsById.get(pluginId);
		if (!bundled || !recordMatchesBundledPackage(record, bundled)) continue;
		if (nextRecords === records) nextRecords = { ...records };
		delete nextRecords[pluginId];
		changes.push(`Removed stale managed install record for bundled plugin "${pluginId}".`);
	}
	if (shouldDeferConfiguredPluginInstallRepair(env)) {
		const updateDeferredPluginIds = collectUpdateDeferredPluginIds({
			cfg: params.cfg,
			env,
			configuredPluginIds: params.pluginIds,
			configuredChannelIds: params.channelIds,
			configuredChannelOwnerPluginIds,
			blockedPluginIds: params.blockedPluginIds
		});
		for (const pluginId of updateDeferredPluginIds) {
			deferredPluginIds.add(pluginId);
			const record = nextRecords[pluginId];
			if (!record || !isInstalledRecordMissingOnDisk(record, env)) continue;
			changes.push(`Skipped package-manager repair for configured plugin "${pluginId}" during package update; rerun "openclaw doctor --fix" after the update completes.`);
		}
	}
	const missingRecordedPluginIds = Object.keys(records).filter((pluginId) => !deferredPluginIds.has(pluginId) && !officialReplacementPluginIds.has(pluginId) && Object.hasOwn(nextRecords, pluginId) && !bundledPluginsById.has(pluginId) && (params.pluginIds.has(pluginId) && (!knownIds.has(pluginId) || isInstalledRecordMissingOnDisk(nextRecords[pluginId], env)) || configuredPluginIdsWithStaleDescriptors.has(pluginId) || installedPluginIdsWithRepairablePackageDiagnostics.has(pluginId)));
	if (missingRecordedPluginIds.length > 0) {
		for (const pluginId of missingRecordedPluginIds) {
			const record = nextRecords[pluginId];
			if (!record) continue;
			const forced = forceNpmInstallRecordRepair(record);
			if (forced !== record) {
				if (nextRecords === records) nextRecords = { ...records };
				nextRecords[pluginId] = forced;
			}
		}
		const updateResult = await updateNpmInstalledPlugins({
			config: {
				...params.cfg,
				plugins: {
					...params.cfg.plugins,
					installs: nextRecords
				}
			},
			pluginIds: missingRecordedPluginIds,
			updateChannel,
			logger: {
				warn: (message) => warnings.push(message),
				error: (message) => warnings.push(message)
			}
		});
		for (const outcome of updateResult.outcomes) if (outcome.status === "updated" || outcome.status === "unchanged") changes.push(installedPluginIdsWithRepairablePackageDiagnostics.has(outcome.pluginId) ? `Repaired broken installed plugin "${outcome.pluginId}".` : `Repaired missing configured plugin "${outcome.pluginId}".`);
		else if (outcome.status === "error") {
			warnings.push(outcome.message);
			failedPluginIds.add(outcome.pluginId);
		}
		nextRecords = updateResult.config.plugins?.installs ?? nextRecords;
	}
	const missingPluginIds = new Set([...params.pluginIds].filter((pluginId) => {
		if (deferredPluginIds.has(pluginId)) return false;
		const hasRecord = Object.hasOwn(nextRecords, pluginId);
		return !knownIds.has(pluginId) && !hasRecord && !bundledPluginsById.has(pluginId) || hasRecord && !bundledPluginsById.has(pluginId) && isInstalledRecordMissingOnDisk(nextRecords[pluginId], env);
	}));
	const installCandidatePluginIds = new Set([...missingPluginIds, ...officialReplacementPluginIds]);
	for (const candidate of collectDownloadableInstallCandidates({
		cfg: params.cfg,
		env,
		missingPluginIds: installCandidatePluginIds,
		configuredPluginIds: params.pluginIds,
		configuredChannelIds: params.channelIds,
		configuredChannelOwnerPluginIds,
		blockedPluginIds: deferredPluginIds.size > 0 ? new Set([...params.blockedPluginIds ?? [], ...deferredPluginIds]) : params.blockedPluginIds
	})) {
		if (bundledPluginsById.has(candidate.pluginId)) continue;
		const shouldReplaceBrokenOfficialInstall = officialReplacementPluginIds.has(candidate.pluginId);
		if (shouldReplaceBrokenOfficialInstall && !candidate.trustedSourceLinkedOfficialInstall) continue;
		const record = nextRecords[candidate.pluginId];
		if (shouldReplaceBrokenOfficialInstall && !isTrustedOfficialInstallRecordForCandidate({
			record,
			candidate
		})) continue;
		const hasUsableRecord = Object.hasOwn(nextRecords, candidate.pluginId) && !isInstalledRecordMissingOnDisk(nextRecords[candidate.pluginId], env);
		if (!shouldReplaceBrokenOfficialInstall && knownIds.has(candidate.pluginId) && hasUsableRecord) continue;
		if (!shouldReplaceBrokenOfficialInstall && hasUsableRecord) continue;
		const removalPath = shouldReplaceBrokenOfficialInstall ? resolveSafeBrokenOfficialInstallRemovalPath({
			pluginId: candidate.pluginId,
			candidate,
			record,
			env
		}) : null;
		const previousRecords = nextRecords;
		const installed = await installCandidate({
			candidate,
			records: nextRecords,
			env,
			updateChannel,
			mode: shouldReplaceBrokenOfficialInstall ? "update" : "install",
			preferNpm: preferNpmInstalls
		});
		if (shouldReplaceBrokenOfficialInstall) {
			const installedRecord = installed.records[candidate.pluginId];
			if (installed.records !== previousRecords && removalPath && (!installedRecord?.installPath || !pathsEqual(resolveUserPath(installedRecord.installPath, env), removalPath))) try {
				await rm(removalPath, {
					recursive: true,
					force: true
				});
			} catch (error) {
				warnings.push(`Failed to remove broken installed plugin "${candidate.pluginId}" at ${removalPath}: ${String(error)}`);
			}
		}
		nextRecords = installed.records;
		changes.push(...installed.changes);
		warnings.push(...installed.warnings);
		if (installed.failedPluginId) failedPluginIds.add(installed.failedPluginId);
	}
	if (nextRecords !== records) await writePersistedInstalledPluginIndexInstallRecords(nextRecords, { env });
	else if (params.baselineRecords) await writePersistedInstalledPluginIndexInstallRecords(nextRecords, { env });
	return {
		changes,
		warnings,
		...failedPluginIds.size > 0 ? { failedPluginIds: [...failedPluginIds].toSorted((left, right) => left.localeCompare(right)) } : {},
		records: nextRecords
	};
}
//#endregion
export { repairMissingPluginInstallsForIds as n, repairMissingConfiguredPluginInstalls as t };
