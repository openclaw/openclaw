import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { p as resolveUserPath } from "./utils-D5swhEXt.js";
import { n as VERSION } from "./version-DdTF4eka.js";
import { f as loadInstalledPluginIndex } from "./installed-plugin-index-store-DH9sPamj.js";
import { t as parseClawHubPluginSpec } from "./clawhub-spec-CIPRxT8T.js";
import { F as parseRegistryNpmSpec } from "./discovery-CVL9-KJt.js";
import { r as resolveDefaultPluginExtensionsDir } from "./install-paths-Bj7Ll1xM.js";
import { o as loadInstalledPluginIndexInstallRecords } from "./manifest-registry-BiAsJcRZ.js";
import { a as listOfficialExternalPluginCatalogEntries, c as resolveOfficialExternalPluginInstall, l as resolveOfficialExternalPluginLabel, s as resolveOfficialExternalPluginId } from "./official-external-plugin-catalog--64MlR6o.js";
import { t as buildNpmResolutionInstallFields } from "./installs-C2YEpXVd.js";
import { s as writePersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records-BRlrlFRP.js";
import { r as listChannelPluginCatalogEntries } from "./catalog-CSeJmulb.js";
import { n as resolveWebSearchInstallCatalogEntry } from "./web-search-install-catalog-DXeey8BR.js";
import { s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-C5sNgq2P.js";
import { i as listPotentialConfiguredChannelIds, r as listExplicitlyDisabledChannelIdsForConfig } from "./config-presence-C44lEvky.js";
import { h as resolveConfiguredChannelPresencePolicy } from "./channel-plugin-ids-DS5EhyfC.js";
import { i as installPluginFromNpmSpec } from "./install-rFtHhX51.js";
import { r as installPluginFromClawHub, t as CLAWHUB_INSTALL_ERROR_CODE } from "./clawhub-Bn7NvSVu.js";
import { l as resolveRegistryUpdateChannel, s as normalizeUpdateChannel } from "./update-channels-BhcOW4ZK.js";
import { t as buildClawHubPluginInstallRecordFields } from "./clawhub-install-records-BYJ2bUx1.js";
import { n as resolveNpmInstallSpecsForUpdateChannel, t as resolveClawHubInstallSpecsForUpdateChannel } from "./install-channel-specs-CBQm8ouW.js";
import { i as updateNpmInstalledPlugins } from "./update-DxIb2fZR.js";
import { t as resolveProviderInstallCatalogEntries } from "./provider-install-catalog-D2Sh8LXm.js";
import { t as asObjectRecord } from "./object-Bnd2uDTG.js";
import { existsSync } from "node:fs";
import path from "node:path";
//#region src/commands/doctor/shared/missing-configured-plugin-install.ts
const RUNTIME_PLUGIN_INSTALL_CANDIDATES = [{
	pluginId: "acpx",
	label: "ACPX Runtime",
	npmSpec: "@openclaw/acpx",
	trustedSourceLinkedOfficialInstall: true
}, {
	pluginId: "codex",
	label: "Codex",
	npmSpec: "@openclaw/codex",
	trustedSourceLinkedOfficialInstall: true
}];
const MISSING_CHANNEL_CONFIG_DESCRIPTOR_DIAGNOSTIC = "without channelConfigs metadata";
const UPDATE_IN_PROGRESS_ENV = "OPENCLAW_UPDATE_IN_PROGRESS";
function shouldFallbackClawHubToNpm(result) {
	return result.code === CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND || result.code === CLAWHUB_INSTALL_ERROR_CODE.VERSION_NOT_FOUND;
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
	addConfiguredPluginId(ids, env?.OPENCLAW_AGENT_RUNTIME);
	const agents = asObjectRecord(cfg.agents);
	addConfiguredPluginId(ids, asObjectRecord(asObjectRecord(agents?.defaults)?.agentRuntime)?.id);
	const list = Array.isArray(agents?.list) ? agents.list : [];
	for (const entry of list) addConfiguredPluginId(ids, asObjectRecord(asObjectRecord(entry)?.agentRuntime)?.id);
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
	const acp = asObjectRecord(cfg.acp);
	const acpBackend = typeof acp?.backend === "string" ? acp.backend.trim().toLowerCase() : "";
	if ((acpBackend === "acpx" || acp?.enabled === true || asObjectRecord(acp?.dispatch)?.enabled === true) && (!acpBackend || acpBackend === "acpx")) ids.add("acpx");
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
	for (const entry of RUNTIME_PLUGIN_INSTALL_CANDIDATES) {
		if (!configuredPluginIds.has(entry.pluginId) && !params.missingPluginIds.has(entry.pluginId)) continue;
		if (params.blockedPluginIds?.has(entry.pluginId)) continue;
		if (!candidates.has(entry.pluginId)) candidates.set(entry.pluginId, entry);
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
function isInstalledRecordMissingOnDisk(record, env) {
	const installPath = record?.installPath?.trim();
	if (!installPath) return true;
	const resolved = resolveUserPath(installPath, env);
	return !existsSync(path.join(resolved, "package.json"));
}
function isUpdatePackageDoctorPass(env) {
	return env[UPDATE_IN_PROGRESS_ENV] === "1";
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
	const extensionsDir = resolveDefaultPluginExtensionsDir();
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
	if (clawhubInstallSpec && candidate.defaultChoice !== "npm") {
		const clawhubResult = await installPluginFromClawHub({
			spec: clawhubInstallSpec,
			extensionsDir,
			expectedPluginId: candidate.pluginId,
			mode: "install"
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
		if (!npmInstallSpec || !shouldFallbackClawHubToNpm(clawhubResult)) return {
			records: params.records,
			changes: [],
			warnings: [`Failed to install missing configured plugin "${candidate.pluginId}" from ${clawhubInstallSpec}: ${clawhubResult.error}`]
		};
		changes.push(`ClawHub ${clawhubInstallSpec} unavailable for "${candidate.pluginId}"; falling back to npm ${npmInstallSpec}.`);
	}
	if (!npmInstallSpec) return {
		records: params.records,
		changes: [],
		warnings: [`Failed to install missing configured plugin "${candidate.pluginId}": missing npm spec.`]
	};
	const result = await installPluginFromNpmSpec({
		spec: npmInstallSpec,
		extensionsDir,
		expectedPluginId: candidate.pluginId,
		expectedIntegrity: candidate.expectedIntegrity,
		...candidate.trustedSourceLinkedOfficialInstall ? { trustedSourceLinkedOfficialInstall: true } : {},
		mode: "install"
	});
	if (!result.ok) return {
		records: params.records,
		changes: [],
		warnings: [`Failed to install missing configured plugin "${candidate.pluginId}" from ${npmInstallSpec}: ${result.error}`]
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
async function repairMissingConfiguredPluginInstalls(params) {
	return repairMissingPluginInstalls({
		cfg: params.cfg,
		env: params.env,
		pluginIds: collectConfiguredPluginIds(params.cfg, params.env),
		channelIds: collectConfiguredChannelIds(params.cfg, params.env),
		blockedPluginIds: collectBlockedPluginIds(params.cfg)
	});
}
async function repairMissingPluginInstallsForIds(params) {
	return repairMissingPluginInstalls({
		cfg: params.cfg,
		env: params.env,
		pluginIds: new Set([...params.pluginIds].map((pluginId) => pluginId.trim()).filter((pluginId) => pluginId)),
		channelIds: new Set([...params.channelIds ?? []].map((channelId) => channelId.trim()).filter((channelId) => channelId)),
		blockedPluginIds: new Set([...params.blockedPluginIds ?? []].map((pluginId) => pluginId.trim()).filter((pluginId) => pluginId))
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
	const records = await loadInstalledPluginIndexInstallRecords({ env });
	const changes = [];
	const warnings = [];
	const deferredPluginIds = /* @__PURE__ */ new Set();
	const updateChannel = resolveRegistryUpdateChannel({
		configChannel: normalizeUpdateChannel(params.cfg.update?.channel),
		currentVersion: VERSION
	});
	let nextRecords = records;
	for (const [pluginId, record] of Object.entries(records)) {
		const bundled = bundledPluginsById.get(pluginId);
		if (!bundled || !recordMatchesBundledPackage(record, bundled)) continue;
		if (nextRecords === records) nextRecords = { ...records };
		delete nextRecords[pluginId];
		changes.push(`Removed stale managed install record for bundled plugin "${pluginId}".`);
	}
	if (isUpdatePackageDoctorPass(env)) {
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
	const missingRecordedPluginIds = Object.keys(records).filter((pluginId) => !deferredPluginIds.has(pluginId) && Object.hasOwn(nextRecords, pluginId) && !bundledPluginsById.has(pluginId) && (params.pluginIds.has(pluginId) && (!knownIds.has(pluginId) || isInstalledRecordMissingOnDisk(nextRecords[pluginId], env)) || configuredPluginIdsWithStaleDescriptors.has(pluginId)));
	if (missingRecordedPluginIds.length > 0) {
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
		for (const outcome of updateResult.outcomes) if (outcome.status === "updated" || outcome.status === "unchanged") changes.push(`Repaired missing configured plugin "${outcome.pluginId}".`);
		else if (outcome.status === "error") warnings.push(outcome.message);
		nextRecords = updateResult.config.plugins?.installs ?? nextRecords;
	}
	const missingPluginIds = new Set([...params.pluginIds].filter((pluginId) => {
		if (deferredPluginIds.has(pluginId)) return false;
		const hasRecord = Object.hasOwn(nextRecords, pluginId);
		return !knownIds.has(pluginId) && !hasRecord && !bundledPluginsById.has(pluginId) || hasRecord && !bundledPluginsById.has(pluginId) && isInstalledRecordMissingOnDisk(nextRecords[pluginId], env);
	}));
	for (const candidate of collectDownloadableInstallCandidates({
		cfg: params.cfg,
		env,
		missingPluginIds,
		configuredPluginIds: params.pluginIds,
		configuredChannelIds: params.channelIds,
		configuredChannelOwnerPluginIds,
		blockedPluginIds: deferredPluginIds.size > 0 ? new Set([...params.blockedPluginIds ?? [], ...deferredPluginIds]) : params.blockedPluginIds
	})) {
		if (bundledPluginsById.has(candidate.pluginId)) continue;
		const hasUsableRecord = Object.hasOwn(nextRecords, candidate.pluginId) && !isInstalledRecordMissingOnDisk(nextRecords[candidate.pluginId], env);
		if (knownIds.has(candidate.pluginId) && hasUsableRecord) continue;
		if (hasUsableRecord) continue;
		const installed = await installCandidate({
			candidate,
			records: nextRecords,
			updateChannel
		});
		nextRecords = installed.records;
		changes.push(...installed.changes);
		warnings.push(...installed.warnings);
	}
	if (nextRecords !== records) await writePersistedInstalledPluginIndexInstallRecords(nextRecords, { env });
	return {
		changes,
		warnings
	};
}
//#endregion
export { repairMissingPluginInstallsForIds as n, repairMissingConfiguredPluginInstalls as t };
