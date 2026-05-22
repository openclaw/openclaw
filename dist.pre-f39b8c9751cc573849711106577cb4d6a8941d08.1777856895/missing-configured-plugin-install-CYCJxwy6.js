import { o as loadInstalledPluginIndexInstallRecords } from "./manifest-registry-C9Iavh95.js";
import { t as buildNpmResolutionInstallFields } from "./installs-7vLN_TJc.js";
import { s as writePersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records-J72_jxlC.js";
import { c as resolveOfficialExternalPluginLabel, i as listOfficialExternalPluginCatalogEntries, o as resolveOfficialExternalPluginId, s as resolveOfficialExternalPluginInstall } from "./official-external-plugin-catalog-mkQ1P8p4.js";
import { n as resolveWebSearchInstallCatalogEntry } from "./web-search-install-catalog-DAeN6I8Q.js";
import { s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-LHRBn9J1.js";
import { i as listPotentialConfiguredChannelIds, r as listExplicitlyDisabledChannelIdsForConfig } from "./config-presence-DxdnaPR0.js";
import { r as resolveDefaultPluginExtensionsDir } from "./install-paths-C_LmNm4-.js";
import { i as installPluginFromNpmSpec } from "./install-DlUfLS0M.js";
import { r as installPluginFromClawHub, t as CLAWHUB_INSTALL_ERROR_CODE } from "./clawhub-Ce5QUBkG.js";
import { r as listChannelPluginCatalogEntries } from "./catalog-DctSGam3.js";
import { t as buildClawHubPluginInstallRecordFields } from "./clawhub-install-records-Do0_ayve.js";
import { n as updateNpmInstalledPlugins } from "./update-CIRtUsz2.js";
import { t as resolveProviderInstallCatalogEntries } from "./provider-install-catalog-BUBtOW-1.js";
import { t as asObjectRecord } from "./object-BahxEJYN.js";
//#region src/commands/doctor/shared/missing-configured-plugin-install.ts
const RUNTIME_PLUGIN_INSTALL_CANDIDATES = [{
	pluginId: "acpx",
	label: "ACPX Runtime",
	npmSpec: "@openclaw/acpx"
}, {
	pluginId: "codex",
	label: "Codex",
	npmSpec: "@openclaw/codex"
}];
const MISSING_CHANNEL_CONFIG_DESCRIPTOR_DIAGNOSTIC = "without channelConfigs metadata";
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
	const allow = Array.isArray(plugins?.allow) ? plugins.allow : [];
	for (const value of allow) addConfiguredPluginId(ids, value);
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
function collectDownloadableInstallCandidates(params) {
	const configuredPluginIds = params.configuredPluginIds ?? collectConfiguredPluginIds(params.cfg, params.env);
	const configuredChannelIds = params.configuredChannelIds ?? collectConfiguredChannelIds(params.cfg, params.env);
	const candidates = /* @__PURE__ */ new Map();
	for (const entry of listChannelPluginCatalogEntries({
		env: params.env,
		excludeWorkspace: true
	})) {
		const pluginId = entry.pluginId ?? entry.id;
		if (params.blockedPluginIds?.has(pluginId)) continue;
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
			...install.defaultChoice ? { defaultChoice: install.defaultChoice } : {}
		});
	}
	for (const entry of RUNTIME_PLUGIN_INSTALL_CANDIDATES) {
		if (!configuredPluginIds.has(entry.pluginId) && !params.missingPluginIds.has(entry.pluginId)) continue;
		if (params.blockedPluginIds?.has(entry.pluginId)) continue;
		candidates.set(entry.pluginId, entry);
	}
	return [...candidates.values()].toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
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
async function installCandidate(params) {
	const { candidate } = params;
	const extensionsDir = resolveDefaultPluginExtensionsDir();
	const changes = [];
	if (candidate.clawhubSpec && candidate.defaultChoice !== "npm") {
		const clawhubResult = await installPluginFromClawHub({
			spec: candidate.clawhubSpec,
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
						spec: candidate.clawhubSpec,
						installPath: clawhubResult.targetDir,
						installedAt: (/* @__PURE__ */ new Date()).toISOString()
					}
				},
				changes: [`Installed missing configured plugin "${pluginId}" from ${candidate.clawhubSpec}.`],
				warnings: []
			};
		}
		if (!candidate.npmSpec || !shouldFallbackClawHubToNpm(clawhubResult)) return {
			records: params.records,
			changes: [],
			warnings: [`Failed to install missing configured plugin "${candidate.pluginId}" from ${candidate.clawhubSpec}: ${clawhubResult.error}`]
		};
		changes.push(`ClawHub ${candidate.clawhubSpec} unavailable for "${candidate.pluginId}"; falling back to npm ${candidate.npmSpec}.`);
	}
	if (!candidate.npmSpec) return {
		records: params.records,
		changes: [],
		warnings: [`Failed to install missing configured plugin "${candidate.pluginId}": missing npm spec.`]
	};
	const result = await installPluginFromNpmSpec({
		spec: candidate.npmSpec,
		extensionsDir,
		expectedPluginId: candidate.pluginId,
		expectedIntegrity: candidate.expectedIntegrity,
		mode: "install"
	});
	if (!result.ok) return {
		records: params.records,
		changes: [],
		warnings: [`Failed to install missing configured plugin "${candidate.pluginId}" from ${candidate.npmSpec}: ${result.error}`]
	};
	const pluginId = result.pluginId;
	return {
		records: {
			...params.records,
			[pluginId]: {
				source: "npm",
				spec: candidate.npmSpec,
				installPath: result.targetDir,
				version: result.version,
				installedAt: (/* @__PURE__ */ new Date()).toISOString(),
				...buildNpmResolutionInstallFields(result.npmResolution)
			}
		},
		changes: [...changes, `Installed missing configured plugin "${pluginId}" from ${candidate.npmSpec}.`],
		warnings: []
	};
}
async function repairMissingConfiguredPluginInstalls(params) {
	return repairMissingPluginInstalls({
		cfg: params.cfg,
		env: params.env,
		pluginIds: collectConfiguredPluginIds(params.cfg, params.env),
		channelIds: collectConfiguredChannelIds(params.cfg, params.env)
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
	const knownIds = new Set(snapshot.plugins.map((plugin) => plugin.id));
	const configuredPluginIdsWithStaleDescriptors = collectConfiguredPluginIdsWithMissingChannelConfigDescriptors({
		snapshot,
		configuredPluginIds: params.pluginIds,
		configuredChannelIds: params.channelIds
	});
	const records = await loadInstalledPluginIndexInstallRecords({ env });
	const missingRecordedPluginIds = Object.keys(records).filter((pluginId) => params.pluginIds.has(pluginId) && !knownIds.has(pluginId) || configuredPluginIdsWithStaleDescriptors.has(pluginId));
	const changes = [];
	const warnings = [];
	let nextRecords = records;
	if (missingRecordedPluginIds.length > 0) {
		const updateResult = await updateNpmInstalledPlugins({
			config: {
				...params.cfg,
				plugins: {
					...params.cfg.plugins,
					installs: records
				}
			},
			pluginIds: missingRecordedPluginIds,
			updateChannel: params.cfg.update?.channel,
			logger: {
				warn: (message) => warnings.push(message),
				error: (message) => warnings.push(message)
			}
		});
		for (const outcome of updateResult.outcomes) if (outcome.status === "updated" || outcome.status === "unchanged") changes.push(`Repaired missing configured plugin "${outcome.pluginId}".`);
		else if (outcome.status === "error") warnings.push(outcome.message);
		nextRecords = updateResult.config.plugins?.installs ?? nextRecords;
	}
	const missingPluginIds = new Set([...params.pluginIds].filter((pluginId) => !knownIds.has(pluginId) && !Object.hasOwn(nextRecords, pluginId)));
	for (const candidate of collectDownloadableInstallCandidates({
		cfg: params.cfg,
		env,
		missingPluginIds,
		configuredPluginIds: params.pluginIds,
		configuredChannelIds: params.channelIds,
		blockedPluginIds: params.blockedPluginIds
	})) {
		if (knownIds.has(candidate.pluginId) || Object.hasOwn(nextRecords, candidate.pluginId)) continue;
		const installed = await installCandidate({
			candidate,
			records: nextRecords
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
