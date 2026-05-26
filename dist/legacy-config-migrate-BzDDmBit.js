import { c as isRecord } from "./utils-sBTEdeml.js";
import { T as validateConfigObjectWithPlugins } from "./io-DoswVvYe.js";
import { t as getBootstrapChannelPlugin } from "./bootstrap-registry-W87CNNcz.js";
import { n as collectRelevantDoctorPluginIds, t as applyPluginDoctorCompatibilityMigrations } from "./doctor-contract-registry-MGGe8kxH.js";
import { o as loadBundledChannelDoctorContractApi, t as LEGACY_CONFIG_MIGRATIONS } from "./legacy-config-migrations-BXj3KPAt.js";
import "./legacy-config-record-shared-CpOX8vW0.js";
//#region src/commands/doctor/shared/channel-legacy-config-migrate.ts
function collectRelevantDoctorChannelIds(raw) {
	const channels = isRecord(raw) && isRecord(raw.channels) ? raw.channels : null;
	if (!channels) return [];
	return Object.keys(channels).filter((channelId) => channelId !== "defaults").toSorted();
}
function resolveBundledChannelCompatibilityNormalizer(channelId) {
	const contractNormalizer = loadBundledChannelDoctorContractApi(channelId)?.normalizeCompatibilityConfig;
	if (typeof contractNormalizer === "function") return contractNormalizer;
	return getBootstrapChannelPlugin(channelId)?.doctor?.normalizeCompatibilityConfig;
}
function collectPluginDoctorCompatibilityIds(params) {
	const unresolvedChannelIds = new Set(params.unresolvedChannelIds);
	return [...new Set([...params.unresolvedChannelIds, ...collectRelevantDoctorPluginIds(params.raw).filter((pluginId) => !unresolvedChannelIds.has(pluginId))])].toSorted();
}
function applyChannelDoctorCompatibilityMigrations(cfg) {
	let nextCfg = cfg;
	const changes = [];
	const unresolvedChannelIds = [];
	for (const channelId of collectRelevantDoctorChannelIds(cfg)) {
		const normalizeCompatibilityConfig = resolveBundledChannelCompatibilityNormalizer(channelId);
		if (!normalizeCompatibilityConfig) {
			unresolvedChannelIds.push(channelId);
			continue;
		}
		const mutation = normalizeCompatibilityConfig({ cfg: nextCfg });
		if (!mutation || mutation.changes.length === 0) continue;
		nextCfg = mutation.config;
		changes.push(...mutation.changes);
	}
	const pluginIds = collectPluginDoctorCompatibilityIds({
		raw: cfg,
		unresolvedChannelIds
	});
	if (pluginIds.length > 0) {
		const compat = applyPluginDoctorCompatibilityMigrations(nextCfg, {
			config: cfg,
			pluginIds
		});
		nextCfg = compat.config;
		changes.push(...compat.changes);
	}
	return {
		next: nextCfg,
		changes
	};
}
//#endregion
//#region src/commands/doctor/shared/legacy-config-compat.ts
function applyLegacyDoctorMigrations(raw) {
	if (!raw || typeof raw !== "object") return {
		next: null,
		changes: []
	};
	const original = raw;
	const next = structuredClone(original);
	const changes = [];
	for (const migration of LEGACY_CONFIG_MIGRATIONS) migration.apply(next, changes);
	const compat = applyChannelDoctorCompatibilityMigrations(next);
	changes.push(...compat.changes);
	if (changes.length === 0) return {
		next: null,
		changes: []
	};
	return {
		next: compat.next,
		changes
	};
}
//#endregion
//#region src/commands/doctor/shared/legacy-config-migrate.ts
function migrateLegacyConfig(raw) {
	const { next, changes } = applyLegacyDoctorMigrations(raw);
	if (!next) return {
		config: null,
		changes: []
	};
	const validated = validateConfigObjectWithPlugins(next);
	if (!validated.ok) {
		changes.push("Migration applied; other validation issues remain — run doctor to review.");
		return {
			config: next,
			changes,
			partiallyValid: true
		};
	}
	return {
		config: validated.config,
		changes
	};
}
//#endregion
export { applyChannelDoctorCompatibilityMigrations as n, migrateLegacyConfig as t };
