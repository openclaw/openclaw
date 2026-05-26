import { n as hasBinary, r as isConfigPathTruthyWithDefaults, t as evaluateRuntimeEligibility } from "./config-eval-BH8jfSqo.js";
import { r as resolveHookKey } from "./frontmatter-D8Mpt4Ck.js";
//#region src/hooks/policy.ts
const HOOK_SOURCE_POLICIES = {
	"openclaw-bundled": {
		precedence: 10,
		trustedLocalCode: true,
		defaultEnableMode: "default-on",
		canOverride: ["openclaw-bundled"],
		canBeOverriddenBy: ["openclaw-managed", "openclaw-plugin"]
	},
	"openclaw-plugin": {
		precedence: 20,
		trustedLocalCode: true,
		defaultEnableMode: "default-on",
		canOverride: ["openclaw-bundled", "openclaw-plugin"],
		canBeOverriddenBy: ["openclaw-managed"]
	},
	"openclaw-managed": {
		precedence: 30,
		trustedLocalCode: true,
		defaultEnableMode: "default-on",
		canOverride: [
			"openclaw-bundled",
			"openclaw-managed",
			"openclaw-plugin"
		],
		canBeOverriddenBy: ["openclaw-managed"]
	},
	"openclaw-workspace": {
		precedence: 40,
		trustedLocalCode: true,
		defaultEnableMode: "explicit-opt-in",
		canOverride: ["openclaw-workspace"],
		canBeOverriddenBy: ["openclaw-workspace"]
	}
};
function getHookSourcePolicy(source) {
	return HOOK_SOURCE_POLICIES[source];
}
function resolveHookConfig(config, hookKey) {
	const hooks = config?.hooks?.internal?.entries;
	if (!hooks || typeof hooks !== "object") return;
	const entry = hooks[hookKey];
	if (!entry || typeof entry !== "object") return;
	return entry;
}
function resolveHookEnableState(params) {
	const { entry, config } = params;
	const hookKey = resolveHookKey(entry.hook.name, entry);
	const hookConfig = params.hookConfig ?? resolveHookConfig(config, hookKey);
	if (entry.hook.source === "openclaw-plugin") return { enabled: true };
	if (hookConfig?.enabled === false) return {
		enabled: false,
		reason: "disabled in config"
	};
	if (getHookSourcePolicy(entry.hook.source).defaultEnableMode === "explicit-opt-in" && hookConfig?.enabled !== true) return {
		enabled: false,
		reason: "workspace hook (disabled by default)"
	};
	return { enabled: true };
}
function canOverrideHook(candidate, existing) {
	const candidatePolicy = getHookSourcePolicy(candidate.hook.source);
	const existingPolicy = getHookSourcePolicy(existing.hook.source);
	return candidatePolicy.canOverride.includes(existing.hook.source) && existingPolicy.canBeOverriddenBy.includes(candidate.hook.source);
}
function resolveHookEntries(entries, opts) {
	const ordered = entries.map((entry, index) => ({
		entry,
		index
	})).toSorted((a, b) => {
		const precedenceDelta = getHookSourcePolicy(a.entry.hook.source).precedence - getHookSourcePolicy(b.entry.hook.source).precedence;
		return precedenceDelta !== 0 ? precedenceDelta : a.index - b.index;
	});
	const merged = /* @__PURE__ */ new Map();
	for (const { entry } of ordered) {
		const existing = merged.get(entry.hook.name);
		if (!existing) {
			merged.set(entry.hook.name, entry);
			continue;
		}
		if (canOverrideHook(entry, existing)) {
			merged.set(entry.hook.name, entry);
			continue;
		}
		opts?.onCollisionIgnored?.({
			name: entry.hook.name,
			kept: existing,
			ignored: entry
		});
	}
	return Array.from(merged.values());
}
//#endregion
//#region src/hooks/config.ts
const DEFAULT_CONFIG_VALUES = {
	"browser.enabled": true,
	"browser.evaluateEnabled": true,
	"workspace.dir": true
};
function isConfigPathTruthy(config, pathStr) {
	return isConfigPathTruthyWithDefaults(config, pathStr, DEFAULT_CONFIG_VALUES);
}
function evaluateHookRuntimeEligibility(params) {
	const { entry, config, hookConfig, eligibility } = params;
	const remote = eligibility?.remote;
	return evaluateRuntimeEligibility({
		os: entry.metadata?.os,
		remotePlatforms: remote?.platforms,
		always: entry.metadata?.always,
		requires: entry.metadata?.requires,
		hasRemoteBin: remote?.hasBin,
		hasAnyRemoteBin: remote?.hasAnyBin,
		hasBin: hasBinary,
		hasEnv: (envName) => Boolean(process.env[envName] || hookConfig?.env?.[envName]),
		isConfigPathTruthy: (configPath) => isConfigPathTruthy(config, configPath)
	});
}
function shouldIncludeHook(params) {
	const { entry, config, eligibility } = params;
	const hookConfig = resolveHookConfig(config, params.entry.metadata?.hookKey ?? params.entry.hook.name);
	if (!resolveHookEnableState({
		entry,
		config,
		hookConfig
	}).enabled) return false;
	return evaluateHookRuntimeEligibility({
		entry,
		config,
		hookConfig,
		eligibility
	});
}
//#endregion
export { resolveHookEntries as a, resolveHookEnableState as i, shouldIncludeHook as n, resolveHookConfig as r, isConfigPathTruthy as t };
