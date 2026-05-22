import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { c as isRecord } from "./utils-CCskKJVV.js";
import { n as listBundledChannelIdsForPackageState, t as hasBundledChannelPackageState } from "./package-state-probes-CdSjV_Ry.js";
import { t as resolveAgentRuntimePolicy } from "./agent-runtime-policy-DdtTRuVv.js";
import { i as listBundledChannelPluginIds } from "./bootstrap-registry-Cz-tF5PY.js";
import { i as hasNonEmptyString } from "./channel-target-Cc6BhvYu.js";
import fs from "node:fs";
import os from "node:os";
//#region src/agents/harness-runtimes.ts
function collectConfiguredAgentHarnessRuntimes(config, env) {
	const runtimes = /* @__PURE__ */ new Set();
	const pushRuntime = (value) => {
		if (typeof value !== "string") return;
		const normalized = normalizeOptionalLowercaseString(value);
		if (!normalized || normalized === "auto" || normalized === "pi") return;
		runtimes.add(normalized);
	};
	pushRuntime(resolveAgentRuntimePolicy(config.agents?.defaults)?.id);
	if (Array.isArray(config.agents?.list)) for (const agent of config.agents.list) {
		if (!isRecord(agent)) continue;
		pushRuntime(resolveAgentRuntimePolicy(agent)?.id);
	}
	pushRuntime(env.OPENCLAW_AGENT_RUNTIME);
	return [...runtimes].toSorted((left, right) => left.localeCompare(right));
}
//#endregion
//#region src/channels/plugins/persisted-auth-state.ts
function listBundledChannelIdsWithPersistedAuthState() {
	return listBundledChannelIdsForPackageState("persistedAuthState");
}
function hasBundledChannelPersistedAuthState(params) {
	return hasBundledChannelPackageState({
		metadataKey: "persistedAuthState",
		channelId: params.channelId,
		cfg: params.cfg,
		env: params.env
	});
}
//#endregion
//#region src/channels/config-presence.ts
const IGNORED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);
function hasMeaningfulChannelConfig(value) {
	if (!isRecord(value)) return false;
	return Object.keys(value).some((key) => key !== "enabled");
}
function listExplicitlyDisabledChannelIdsForConfig(cfg) {
	const channels = isRecord(cfg.channels) ? cfg.channels : null;
	if (!channels) return [];
	return Object.entries(channels).filter(([, value]) => isRecord(value) && value.enabled === false).map(([channelId]) => normalizeOptionalLowercaseString(channelId)).filter((channelId) => Boolean(channelId));
}
function listChannelEnvPrefixes(channelIds) {
	return channelIds.map((channelId) => [`${channelId.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_`, channelId]);
}
function hasPersistedChannelState(env) {
	return fs.existsSync(resolveStateDir(env, os.homedir));
}
let persistedAuthStateChannelIds = null;
function listPersistedAuthStateChannelIds(options) {
	const override = options.persistedAuthStateProbe?.listChannelIds();
	if (override) return override;
	if (persistedAuthStateChannelIds) return persistedAuthStateChannelIds;
	persistedAuthStateChannelIds = listBundledChannelIdsWithPersistedAuthState();
	return persistedAuthStateChannelIds;
}
function hasPersistedAuthState(params) {
	const override = params.options.persistedAuthStateProbe;
	if (override) return override.hasState(params);
	return hasBundledChannelPersistedAuthState(params);
}
function listPotentialConfiguredChannelIds(cfg, env = process.env, options = {}) {
	return [...new Set(listPotentialConfiguredChannelPresenceSignals(cfg, env, options).map((signal) => signal.channelId))];
}
function listPotentialConfiguredChannelPresenceSignals(cfg, env = process.env, options = {}) {
	const signals = [];
	const seenSignals = /* @__PURE__ */ new Set();
	const addSignal = (channelId, source) => {
		const key = `${source}:${channelId}`;
		if (seenSignals.has(key)) return;
		seenSignals.add(key);
		signals.push({
			channelId,
			source
		});
	};
	const configuredChannelIds = /* @__PURE__ */ new Set();
	const channelEnvPrefixes = listChannelEnvPrefixes(options.channelIds ?? listBundledChannelPluginIds(env));
	const channels = isRecord(cfg.channels) ? cfg.channels : null;
	if (channels) for (const [key, value] of Object.entries(channels)) {
		if (IGNORED_CHANNEL_CONFIG_KEYS.has(key)) continue;
		if (hasMeaningfulChannelConfig(value)) {
			configuredChannelIds.add(key);
			addSignal(key, "config");
		}
	}
	for (const [key, value] of Object.entries(env)) {
		if (!hasNonEmptyString(value)) continue;
		for (const [prefix, channelId] of channelEnvPrefixes) if (key.startsWith(prefix)) {
			configuredChannelIds.add(channelId);
			addSignal(channelId, "env");
		}
	}
	if (options.includePersistedAuthState !== false && hasPersistedChannelState(env)) {
		for (const channelId of listPersistedAuthStateChannelIds(options)) if (hasPersistedAuthState({
			channelId,
			cfg,
			env,
			options
		})) {
			configuredChannelIds.add(channelId);
			addSignal(channelId, "persisted-auth");
		}
	}
	return signals.filter((signal) => configuredChannelIds.has(signal.channelId));
}
function hasEnvConfiguredChannel(cfg, env, options = {}) {
	const channelEnvPrefixes = listChannelEnvPrefixes(options.channelIds ?? listBundledChannelPluginIds(env));
	for (const [key, value] of Object.entries(env)) {
		if (!hasNonEmptyString(value)) continue;
		if (channelEnvPrefixes.some(([prefix]) => key.startsWith(prefix))) return true;
	}
	if (options.includePersistedAuthState === false || !hasPersistedChannelState(env)) return false;
	return listPersistedAuthStateChannelIds(options).some((channelId) => hasPersistedAuthState({
		channelId,
		cfg,
		env,
		options
	}));
}
function hasPotentialConfiguredChannels(cfg, env = process.env, options = {}) {
	const channels = isRecord(cfg?.channels) ? cfg.channels : null;
	if (channels) for (const [key, value] of Object.entries(channels)) {
		if (IGNORED_CHANNEL_CONFIG_KEYS.has(key)) continue;
		if (hasMeaningfulChannelConfig(value)) return true;
	}
	return hasEnvConfiguredChannel(cfg ?? {}, env, options);
}
//#endregion
export { listPotentialConfiguredChannelPresenceSignals as a, listPotentialConfiguredChannelIds as i, hasPotentialConfiguredChannels as n, collectConfiguredAgentHarnessRuntimes as o, listExplicitlyDisabledChannelIdsForConfig as r, hasMeaningfulChannelConfig as t };
