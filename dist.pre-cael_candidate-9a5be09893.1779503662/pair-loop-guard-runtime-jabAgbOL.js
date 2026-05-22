//#region src/plugin-sdk/pair-loop-guard-runtime.ts
const PAIR_LOOP_GUARD_CONFIG_KEYS = [
	"enabled",
	"maxEventsPerWindow",
	"windowSeconds",
	"cooldownSeconds"
];
const DEFAULT_PRUNE_INTERVAL_MS = 6e4;
const KEY_SEPARATOR = "";
const DEFAULT_PAIR_LOOP_GUARD_CONFIG = {
	enabled: true,
	maxEventsPerWindow: 20,
	windowSeconds: 60,
	cooldownSeconds: 60
};
const DEFAULT_PAIR_LOOP_GUARD_SETTINGS = {
	enabled: DEFAULT_PAIR_LOOP_GUARD_CONFIG.enabled,
	maxEventsPerWindow: DEFAULT_PAIR_LOOP_GUARD_CONFIG.maxEventsPerWindow,
	windowMs: DEFAULT_PAIR_LOOP_GUARD_CONFIG.windowSeconds * 1e3,
	cooldownMs: DEFAULT_PAIR_LOOP_GUARD_CONFIG.cooldownSeconds * 1e3
};
function mergePairLoopGuardConfig(...configs) {
	const merged = {};
	let hasValue = false;
	for (const config of configs) {
		if (!config) continue;
		for (const key of PAIR_LOOP_GUARD_CONFIG_KEYS) if (config[key] !== void 0) {
			switch (key) {
				case "enabled":
					merged.enabled = config.enabled;
					break;
				case "maxEventsPerWindow":
					merged.maxEventsPerWindow = config.maxEventsPerWindow;
					break;
				case "windowSeconds":
					merged.windowSeconds = config.windowSeconds;
					break;
				case "cooldownSeconds":
					merged.cooldownSeconds = config.cooldownSeconds;
					break;
			}
			hasValue = true;
		}
	}
	return hasValue ? merged : void 0;
}
function positiveInteger(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : void 0;
}
function resolvePairLoopGuardSettings(params) {
	const configuredEnabled = typeof params.config?.enabled === "boolean" ? params.config.enabled : typeof params.defaultsConfig?.enabled === "boolean" ? params.defaultsConfig.enabled : DEFAULT_PAIR_LOOP_GUARD_CONFIG.enabled;
	const maxEventsPerWindow = positiveInteger(params.config?.maxEventsPerWindow) ?? positiveInteger(params.defaultsConfig?.maxEventsPerWindow) ?? DEFAULT_PAIR_LOOP_GUARD_CONFIG.maxEventsPerWindow;
	const windowSeconds = positiveInteger(params.config?.windowSeconds) ?? positiveInteger(params.defaultsConfig?.windowSeconds) ?? DEFAULT_PAIR_LOOP_GUARD_CONFIG.windowSeconds;
	const cooldownSeconds = positiveInteger(params.config?.cooldownSeconds) ?? positiveInteger(params.defaultsConfig?.cooldownSeconds) ?? DEFAULT_PAIR_LOOP_GUARD_CONFIG.cooldownSeconds;
	return {
		enabled: params.defaultEnabled && configuredEnabled,
		maxEventsPerWindow,
		windowMs: windowSeconds * 1e3,
		cooldownMs: cooldownSeconds * 1e3
	};
}
function buildPairKey(params) {
	const lhs = params.senderId < params.receiverId ? params.senderId : params.receiverId;
	const rhs = params.senderId < params.receiverId ? params.receiverId : params.senderId;
	return [
		params.scopeId,
		params.conversationId,
		lhs,
		rhs
	].join(KEY_SEPARATOR);
}
function pruneRecentTimestamps(entry, nowMs, windowMs) {
	const cutoff = nowMs - windowMs;
	entry.recentMs = entry.recentMs.filter((timestampMs) => timestampMs > cutoff);
}
function countCurrentWindowEvents(entry, nowMs) {
	return entry.recentMs.filter((timestampMs) => timestampMs <= nowMs).length;
}
function createPairLoopGuard(params) {
	const tracked = /* @__PURE__ */ new Map();
	const pruneIntervalMs = params?.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
	let nextPruneAtMs = 0;
	function pruneInactiveTrackedPairs(nowMs) {
		if (pruneIntervalMs <= 0 || nowMs < nextPruneAtMs) return;
		nextPruneAtMs = nowMs + pruneIntervalMs;
		for (const [key, entry] of tracked) {
			pruneRecentTimestamps(entry, nowMs, entry.windowMs);
			if (entry.recentMs.length === 0 && entry.cooldownUntilMs <= nowMs) tracked.delete(key);
		}
	}
	function recordAndCheck(params) {
		if (!params.settings.enabled) return { suppressed: false };
		if (!params.scopeId || !params.conversationId || !params.senderId || !params.receiverId) return { suppressed: false };
		if (params.senderId === params.receiverId) return { suppressed: false };
		const maxEventsPerWindow = Math.floor(params.settings.maxEventsPerWindow);
		const windowMs = Math.floor(params.settings.windowMs);
		const cooldownMs = Math.floor(params.settings.cooldownMs);
		if (maxEventsPerWindow <= 0 || windowMs <= 0 || cooldownMs <= 0) return { suppressed: false };
		const nowMs = params.nowMs ?? Date.now();
		pruneInactiveTrackedPairs(nowMs);
		const key = buildPairKey(params);
		let entry = tracked.get(key);
		if (!entry) {
			entry = {
				recentMs: [],
				windowMs,
				cooldownStartedAtMs: 0,
				cooldownUntilMs: 0
			};
			tracked.set(key, entry);
		}
		if (entry.cooldownStartedAtMs <= nowMs && entry.cooldownUntilMs > nowMs) return {
			suppressed: true,
			cooldownUntilMs: entry.cooldownUntilMs
		};
		entry.windowMs = windowMs;
		pruneRecentTimestamps(entry, nowMs, windowMs);
		entry.recentMs.push(nowMs);
		if (countCurrentWindowEvents(entry, nowMs) > maxEventsPerWindow) {
			entry.cooldownStartedAtMs = nowMs;
			entry.cooldownUntilMs = nowMs + cooldownMs;
			entry.recentMs = entry.recentMs.filter((timestampMs) => timestampMs > nowMs);
			return {
				suppressed: true,
				cooldownUntilMs: entry.cooldownUntilMs
			};
		}
		return { suppressed: false };
	}
	return {
		recordAndCheck,
		clear: () => {
			tracked.clear();
			nextPruneAtMs = 0;
		},
		snapshot: () => Array.from(tracked.entries()).map(([key, entry]) => ({
			key,
			recentCount: entry.recentMs.length,
			cooldownUntilMs: entry.cooldownUntilMs
		}))
	};
}
//#endregion
export { resolvePairLoopGuardSettings as a, mergePairLoopGuardConfig as i, DEFAULT_PAIR_LOOP_GUARD_SETTINGS as n, createPairLoopGuard as r, DEFAULT_PAIR_LOOP_GUARD_CONFIG as t };
