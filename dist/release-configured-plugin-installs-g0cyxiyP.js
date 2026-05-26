import { n as VERSION } from "./version-CQfgAE7_.js";
import { r as normalizeChatChannelId } from "./ids-BE_yccbC.js";
import { t as getOfficialExternalPluginCatalogEntry } from "./official-external-plugin-catalog-f6g4JsA2.js";
import { n as resolveWebSearchInstallCatalogEntry } from "./web-search-install-catalog-CbZkTyiv.js";
import { n as collectConfiguredModelRefs } from "./model-refs-BGL2fwMX.js";
import { t as compareOpenClawVersions } from "./version-CAjjTWnS.js";
import "./registry-CtWyD2pE.js";
import { r as detectPluginAutoEnableCandidates } from "./plugin-auto-enable-CuCUT4Z1.js";
import { t as collectConfiguredAgentHarnessRuntimes } from "./harness-runtimes-Da9K6qai.js";
import { a as listPotentialConfiguredChannelPresenceSignals } from "./config-presence-DiJ4UoDg.js";
import { t as isChannelConfigured } from "./channel-configured-B6BYuKoD.js";
import { t as resolveProviderInstallCatalogEntries } from "./provider-install-catalog-BboFtl6M.js";
import { c as shouldDeferConfiguredPluginInstallRepair } from "./update-phase-2jBtHxsn.js";
import { t as asObjectRecord } from "./object-BsiS9JXh.js";
import { n as repairMissingPluginInstallsForIds } from "./missing-configured-plugin-install-D-EYU6f8.js";
const AGENT_HARNESS_RUNTIME_PLUGIN_IDS = { codex: "codex" };
function normalizeId(value) {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}
function isPluginsGloballyDisabled(cfg) {
	return cfg.plugins?.enabled === false;
}
function isDenied(cfg, pluginId) {
	const deny = cfg.plugins?.deny;
	return Array.isArray(deny) && deny.includes(pluginId);
}
function collectBlockedPluginIds(cfg) {
	const ids = /* @__PURE__ */ new Set();
	const deny = cfg.plugins?.deny;
	if (Array.isArray(deny)) for (const pluginId of deny) {
		const normalized = normalizeId(pluginId);
		if (normalized) ids.add(normalized);
	}
	const entries = asObjectRecord(cfg.plugins?.entries);
	for (const [pluginId, entry] of Object.entries(entries ?? {})) if (asObjectRecord(entry)?.enabled === false && pluginId.trim()) ids.add(pluginId.trim());
	return [...ids].toSorted((left, right) => left.localeCompare(right));
}
function isPluginEntryDisabled(cfg, pluginId) {
	return cfg.plugins?.entries?.[pluginId]?.enabled === false;
}
function isChannelDisabled(cfg, channelId) {
	return asObjectRecord(asObjectRecord(cfg.channels)?.[channelId])?.enabled === false;
}
function isDisabled(cfg, pluginId) {
	if (isPluginEntryDisabled(cfg, pluginId)) return true;
	const channelId = normalizeChatChannelId(pluginId);
	return channelId ? isChannelDisabled(cfg, channelId) : false;
}
function hasMaterialPluginEntry(entry) {
	const record = asObjectRecord(entry);
	if (!record) return false;
	return record.enabled === true || asObjectRecord(record.config) !== null || asObjectRecord(record.hooks) !== null || asObjectRecord(record.subagent) !== null || record.apiKey !== void 0 || record.env !== void 0;
}
function collectMaterialPluginEntryIds(cfg) {
	const entries = asObjectRecord(cfg.plugins?.entries);
	if (!entries) return [];
	return Object.entries(entries).filter(([, entry]) => hasMaterialPluginEntry(entry)).map(([pluginId]) => pluginId.trim()).filter((pluginId) => pluginId);
}
function collectSlotPluginIds(cfg) {
	const slots = asObjectRecord(cfg.plugins?.slots);
	return ["memory", "contextEngine"].map((key) => normalizeId(slots?.[key])).filter((pluginId) => !!pluginId && pluginId.toLowerCase() !== "none");
}
function collectConfiguredChannelIds(cfg, env) {
	const ids = /* @__PURE__ */ new Set();
	const channels = asObjectRecord(cfg.channels);
	if (channels) for (const [channelId, value] of Object.entries(channels)) {
		if (channelId === "defaults" || channelId === "modelByChannel" || !channelId.trim()) continue;
		const entry = asObjectRecord(value);
		if (entry?.enabled === false) continue;
		if (entry?.enabled === true || Object.keys(entry ?? {}).some((key) => key !== "enabled")) ids.add(channelId.trim());
	}
	for (const signal of listPotentialConfiguredChannelPresenceSignals(cfg, env, { includePersistedAuthState: false })) {
		const channelId = normalizeChatChannelId(signal.channelId) ?? signal.channelId;
		if (!isChannelDisabled(cfg, channelId) && isChannelConfigured(cfg, channelId, env)) ids.add(channelId);
	}
	return [...ids].toSorted((left, right) => left.localeCompare(right));
}
function collectConfiguredProviderIds(cfg) {
	const ids = /* @__PURE__ */ new Set();
	const add = (value) => {
		const id = normalizeId(value);
		if (id) ids.add(id.toLowerCase());
	};
	for (const profile of Object.values(asObjectRecord(cfg.auth?.profiles) ?? {})) add(asObjectRecord(profile)?.provider);
	for (const providerId of Object.keys(asObjectRecord(cfg.models?.providers) ?? {})) add(providerId);
	const modelByChannel = asObjectRecord(cfg.channels?.modelByChannel);
	for (const [providerId, channelMap] of Object.entries(modelByChannel ?? {})) {
		add(providerId);
		for (const modelRef of Object.values(asObjectRecord(channelMap) ?? {})) {
			if (typeof modelRef !== "string") continue;
			const slash = modelRef.indexOf("/");
			if (slash > 0) add(modelRef.slice(0, slash));
		}
	}
	for (const { value } of collectConfiguredModelRefs(cfg, { includeChannelModelOverrides: false })) {
		const slash = value.indexOf("/");
		if (slash > 0) add(value.slice(0, slash));
	}
	return ids;
}
function collectProviderPluginIds(cfg, env) {
	const configuredProviders = collectConfiguredProviderIds(cfg);
	if (configuredProviders.size === 0) return [];
	const ids = /* @__PURE__ */ new Set();
	for (const entry of resolveProviderInstallCatalogEntries({
		config: cfg,
		env,
		includeUntrustedWorkspacePlugins: false
	})) if (configuredProviders.has(entry.providerId.toLowerCase())) ids.add(entry.pluginId);
	return [...ids].toSorted((left, right) => left.localeCompare(right));
}
function collectAgentHarnessRuntimePluginIds(cfg, env) {
	return collectConfiguredAgentHarnessRuntimes(cfg, env).map((runtime) => AGENT_HARNESS_RUNTIME_PLUGIN_IDS[runtime]).filter((pluginId) => Boolean(pluginId)).toSorted((left, right) => left.localeCompare(right));
}
function collectWebSearchPluginIds(cfg) {
	const providerId = cfg.tools?.web?.search?.provider;
	if (typeof providerId !== "string") return [];
	const entry = resolveWebSearchInstallCatalogEntry({ providerId });
	return entry?.pluginId ? [entry.pluginId] : [];
}
function collectAcpRuntimePluginIds(cfg) {
	const acp = asObjectRecord(cfg.acp);
	if (!acp) return [];
	const backend = normalizeId(acp.backend)?.toLowerCase() ?? "";
	if (!(acp.enabled === true || asObjectRecord(acp.dispatch)?.enabled === true || backend === "acpx") || backend && backend !== "acpx") return [];
	return ["acpx"];
}
function collectAllowOnlyOfficialPluginIds(cfg) {
	const allow = cfg.plugins?.allow;
	if (!Array.isArray(allow) || allow.length === 0) return [];
	const materialEntryIds = new Set(collectMaterialPluginEntryIds(cfg).map((id) => id.toLowerCase()));
	const ids = [];
	for (const rawPluginId of allow) {
		const pluginId = normalizeId(rawPluginId);
		if (!pluginId || materialEntryIds.has(pluginId.toLowerCase())) continue;
		if (getOfficialExternalPluginCatalogEntry(pluginId)) ids.push(pluginId);
	}
	return ids;
}
function addEligiblePluginId(cfg, pluginIds, pluginId) {
	const normalized = pluginId.trim();
	if (!normalized || isDenied(cfg, normalized) || isDisabled(cfg, normalized)) return;
	pluginIds.add(normalized);
}
function shouldRunConfiguredPluginInstallReleaseStep(params) {
	const releaseVersion = params.releaseVersion ?? "2026.5.2-beta.1";
	const currentComparedToRelease = compareOpenClawVersions(params.currentVersion ?? VERSION, releaseVersion);
	if (currentComparedToRelease === null || currentComparedToRelease < 0) return false;
	const touchedComparedToRelease = compareOpenClawVersions(params.touchedVersion, releaseVersion);
	return touchedComparedToRelease === null || touchedComparedToRelease < 0;
}
function collectReleaseConfiguredPluginIds(params) {
	const env = params.env ?? process.env;
	const pluginIds = /* @__PURE__ */ new Set();
	const channelIds = /* @__PURE__ */ new Set();
	if (isPluginsGloballyDisabled(params.cfg)) return {
		pluginIds: [],
		channelIds: []
	};
	for (const candidate of detectPluginAutoEnableCandidates({
		config: params.cfg,
		env
	})) addEligiblePluginId(params.cfg, pluginIds, candidate.pluginId);
	for (const pluginId of collectMaterialPluginEntryIds(params.cfg)) addEligiblePluginId(params.cfg, pluginIds, pluginId);
	for (const pluginId of collectSlotPluginIds(params.cfg)) addEligiblePluginId(params.cfg, pluginIds, pluginId);
	for (const pluginId of collectProviderPluginIds(params.cfg, env)) addEligiblePluginId(params.cfg, pluginIds, pluginId);
	for (const pluginId of collectAgentHarnessRuntimePluginIds(params.cfg, env)) addEligiblePluginId(params.cfg, pluginIds, pluginId);
	for (const pluginId of collectWebSearchPluginIds(params.cfg)) addEligiblePluginId(params.cfg, pluginIds, pluginId);
	for (const pluginId of collectAcpRuntimePluginIds(params.cfg)) addEligiblePluginId(params.cfg, pluginIds, pluginId);
	for (const pluginId of collectAllowOnlyOfficialPluginIds(params.cfg)) addEligiblePluginId(params.cfg, pluginIds, pluginId);
	for (const channelId of collectConfiguredChannelIds(params.cfg, env)) if (!isChannelDisabled(params.cfg, channelId) && !isDenied(params.cfg, channelId) && !isPluginEntryDisabled(params.cfg, channelId)) channelIds.add(channelId);
	return {
		pluginIds: [...pluginIds].toSorted((left, right) => left.localeCompare(right)),
		channelIds: [...channelIds].toSorted((left, right) => left.localeCompare(right))
	};
}
async function maybeRunConfiguredPluginInstallReleaseStep(params) {
	const env = params.env ?? process.env;
	const updateInProgress = shouldDeferConfiguredPluginInstallRepair(env);
	const configured = collectReleaseConfiguredPluginIds({
		cfg: params.cfg,
		env
	});
	if (!shouldRunConfiguredPluginInstallReleaseStep({
		currentVersion: params.currentVersion,
		touchedVersion: params.touchedVersion
	})) {
		if (configured.pluginIds.length === 0 && configured.channelIds.length === 0) return {
			changes: [],
			warnings: [],
			completed: false,
			touchedConfig: false
		};
		const repaired = await repairMissingPluginInstallsForIds({
			cfg: params.cfg,
			pluginIds: configured.pluginIds,
			channelIds: configured.channelIds,
			blockedPluginIds: collectBlockedPluginIds(params.cfg),
			env
		});
		return {
			changes: repaired.changes,
			warnings: repaired.warnings,
			completed: repaired.warnings.length === 0,
			touchedConfig: false
		};
	}
	if (configured.pluginIds.length === 0 && configured.channelIds.length === 0) return {
		changes: [],
		warnings: [],
		completed: true,
		touchedConfig: !updateInProgress
	};
	const repaired = await repairMissingPluginInstallsForIds({
		cfg: params.cfg,
		pluginIds: configured.pluginIds,
		channelIds: configured.channelIds,
		blockedPluginIds: collectBlockedPluginIds(params.cfg),
		env
	});
	const completed = repaired.warnings.length === 0 && !updateInProgress;
	return {
		changes: repaired.changes,
		warnings: repaired.warnings,
		completed,
		touchedConfig: completed
	};
}
//#endregion
export { maybeRunConfiguredPluginInstallReleaseStep };
