import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { f as saveAuthProfileStore, p as updateAuthProfileStoreWithLock } from "./store-BMQkMM4l.js";
import { c as isAuthCooldownBypassedForProvider, s as isActiveUnusableWindow, u as resolveProfileUnusableUntil } from "./order-DJrj83KE.js";
import { s as resolveProviderRequestHeaders } from "./provider-request-config-DxK6PUHR.js";
import { t as redactIdentifier } from "./redact-identifier-DBO6OkZP.js";
import { t as sanitizeForConsole } from "./console-sanitize-BUMxGUp3.js";
//#region src/agents/auth-profiles/state-observation.ts
const observationLog = createSubsystemLogger("agent/embedded");
function logAuthProfileFailureStateChange(params) {
	const windowType = params.reason === "billing" || params.reason === "auth_permanent" ? "disabled" : "cooldown";
	const previousCooldownUntil = params.previous?.cooldownUntil;
	const previousDisabledUntil = params.previous?.disabledUntil;
	const windowReused = windowType === "disabled" ? typeof previousDisabledUntil === "number" && Number.isFinite(previousDisabledUntil) && previousDisabledUntil > params.now && previousDisabledUntil === params.next.disabledUntil : typeof previousCooldownUntil === "number" && Number.isFinite(previousCooldownUntil) && previousCooldownUntil > params.now && previousCooldownUntil === params.next.cooldownUntil;
	const safeProfileId = redactIdentifier(params.profileId, { len: 12 });
	const safeRunId = sanitizeForConsole(params.runId) ?? "-";
	const safeProvider = sanitizeForConsole(params.provider) ?? "-";
	observationLog.warn("auth profile failure state updated", {
		event: "auth_profile_failure_state_updated",
		tags: [
			"error_handling",
			"auth_profiles",
			windowType
		],
		runId: params.runId,
		profileId: safeProfileId,
		provider: params.provider,
		reason: params.reason,
		windowType,
		windowReused,
		previousErrorCount: params.previous?.errorCount,
		errorCount: params.next.errorCount,
		previousCooldownUntil,
		cooldownUntil: params.next.cooldownUntil,
		previousDisabledUntil,
		disabledUntil: params.next.disabledUntil,
		previousDisabledReason: params.previous?.disabledReason,
		disabledReason: params.next.disabledReason,
		failureCounts: params.next.failureCounts,
		consoleMessage: `auth profile failure state updated: runId=${safeRunId} profile=${safeProfileId} provider=${safeProvider} reason=${params.reason} window=${windowType} reused=${String(windowReused)}`
	});
}
//#endregion
//#region src/agents/auth-profiles/usage.ts
const authProfileUsageLog = createSubsystemLogger("agent/embedded");
const authProfileUsageDeps = {
	saveAuthProfileStore,
	updateAuthProfileStoreWithLock
};
let onAuthProfileFailureHook;
function setAuthProfileFailureHook(hook) {
	onAuthProfileFailureHook = hook;
}
const FAILURE_REASON_PRIORITY = [
	"auth_permanent",
	"auth",
	"billing",
	"format",
	"model_not_found",
	"overloaded",
	"timeout",
	"rate_limit",
	"empty_response",
	"no_error_details",
	"unclassified",
	"unknown"
];
const FAILURE_REASON_SET = new Set(FAILURE_REASON_PRIORITY);
const FAILURE_REASON_ORDER = new Map(FAILURE_REASON_PRIORITY.map((reason, index) => [reason, index]));
const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const WHAM_TIMEOUT_MS = 3e3;
const WHAM_BURST_COOLDOWN_MS = 15e3;
const WHAM_PROBE_FAILURE_COOLDOWN_MS = 3e4;
const WHAM_HTTP_ERROR_COOLDOWN_MS = 300 * 1e3;
const WHAM_TOKEN_EXPIRED_COOLDOWN_MS = 720 * 60 * 1e3;
const WHAM_DEAD_ACCOUNT_COOLDOWN_MS = 1440 * 60 * 1e3;
function shouldProbeWhamForFailure(provider, reason) {
	return normalizeProviderId(provider ?? "") === "openai-codex" && (reason === "rate_limit" || reason === "empty_response" || reason === "no_error_details" || reason === "unclassified" || reason === "unknown");
}
function resolveWhamResetMs(window, now) {
	if (!window) return null;
	if (typeof window.reset_after_seconds === "number" && Number.isFinite(window.reset_after_seconds) && window.reset_after_seconds > 0) return window.reset_after_seconds * 1e3;
	if (typeof window.reset_at === "number" && Number.isFinite(window.reset_at) && window.reset_at > 0) return Math.max(0, window.reset_at * 1e3 - now);
	return null;
}
function isWhamWindowExhausted(window) {
	return !!(window && typeof window.used_percent === "number" && Number.isFinite(window.used_percent) && window.used_percent >= 100);
}
function applyWhamCooldownResult(params) {
	const existingCooldownUntil = params.existing.cooldownUntil;
	const existingBlockedUntil = params.existing.blockedUntil;
	const existingActiveCooldownUntil = typeof existingCooldownUntil === "number" && Number.isFinite(existingCooldownUntil) && existingCooldownUntil > params.now ? existingCooldownUntil : 0;
	const existingActiveBlockedUntil = typeof existingBlockedUntil === "number" && Number.isFinite(existingBlockedUntil) && existingBlockedUntil > params.now ? existingBlockedUntil : 0;
	if (params.whamResult.blockedUntil) return {
		...params.computed,
		blockedUntil: Math.max(existingActiveBlockedUntil, params.whamResult.blockedUntil),
		blockedReason: "subscription_limit",
		blockedSource: params.whamResult.blockedSource ?? "wham",
		blockedModel: void 0,
		cooldownUntil: void 0,
		cooldownReason: void 0,
		cooldownModel: void 0
	};
	return {
		...params.computed,
		cooldownUntil: Math.max(existingActiveCooldownUntil, params.now + params.whamResult.cooldownMs)
	};
}
async function probeWhamForCooldown(store, profileId) {
	const profile = store.profiles[profileId];
	if (profile?.type !== "oauth" || !profile.access) return null;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), WHAM_TIMEOUT_MS);
	try {
		const defaultHeaders = {
			Authorization: `Bearer ${profile.access}`,
			Accept: "application/json"
		};
		if (profile.accountId) defaultHeaders["ChatGPT-Account-Id"] = profile.accountId;
		const headers = resolveProviderRequestHeaders({
			provider: "openai-codex",
			baseUrl: WHAM_USAGE_URL,
			capability: "other",
			transport: "http",
			defaultHeaders
		}) ?? defaultHeaders;
		const res = await fetch(WHAM_USAGE_URL, {
			method: "GET",
			headers,
			signal: controller.signal
		});
		if (!res.ok) {
			if (res.status === 401) return {
				cooldownMs: WHAM_TOKEN_EXPIRED_COOLDOWN_MS,
				reason: "wham_token_expired"
			};
			if (res.status === 403) return {
				cooldownMs: WHAM_DEAD_ACCOUNT_COOLDOWN_MS,
				reason: "wham_account_dead"
			};
			return {
				cooldownMs: WHAM_HTTP_ERROR_COOLDOWN_MS,
				reason: "wham_http_error"
			};
		}
		const data = await res.json();
		if (!data.rate_limit) return {
			cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS,
			reason: "wham_probe_failed"
		};
		if (data.rate_limit.limit_reached === false) return {
			cooldownMs: WHAM_BURST_COOLDOWN_MS,
			reason: "wham_burst_contention"
		};
		const now = Date.now();
		const primaryResetMs = resolveWhamResetMs(data.rate_limit.primary_window, now);
		const secondaryResetMs = resolveWhamResetMs(data.rate_limit.secondary_window, now);
		if (!data.rate_limit.secondary_window) {
			if (primaryResetMs === null) return {
				cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS,
				reason: "wham_probe_failed"
			};
			return {
				cooldownMs: WHAM_BURST_COOLDOWN_MS,
				blockedUntil: now + primaryResetMs,
				blockedSource: "wham",
				reason: "wham_personal_rolling"
			};
		}
		if (isWhamWindowExhausted(data.rate_limit.secondary_window)) {
			if (secondaryResetMs === null) return {
				cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS,
				reason: "wham_probe_failed"
			};
			return {
				cooldownMs: WHAM_BURST_COOLDOWN_MS,
				blockedUntil: now + secondaryResetMs,
				blockedSource: "wham",
				reason: "wham_team_weekly"
			};
		}
		if (isWhamWindowExhausted(data.rate_limit.primary_window)) {
			if (primaryResetMs === null) return {
				cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS,
				reason: "wham_probe_failed"
			};
			return {
				cooldownMs: WHAM_BURST_COOLDOWN_MS,
				blockedUntil: now + primaryResetMs,
				blockedSource: "wham",
				reason: "wham_team_rolling"
			};
		}
		return {
			cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS,
			reason: "wham_probe_failed"
		};
	} catch {
		return {
			cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS,
			reason: "wham_probe_failed"
		};
	} finally {
		clearTimeout(timeout);
	}
}
/**
* Infer the most likely reason all candidate profiles are currently unavailable.
*
* We prefer explicit active `disabledReason` values (for example billing/auth)
* over generic cooldown buckets, then fall back to failure-count signals.
*/
function resolveProfilesUnavailableReason(params) {
	const now = params.now ?? Date.now();
	const scores = /* @__PURE__ */ new Map();
	const addScore = (reason, value) => {
		if (!FAILURE_REASON_SET.has(reason) || value <= 0 || !Number.isFinite(value)) return;
		scores.set(reason, (scores.get(reason) ?? 0) + value);
	};
	for (const profileId of params.profileIds) {
		const stats = params.store.usageStats?.[profileId];
		if (!stats) continue;
		if (isActiveUnusableWindow(stats.disabledUntil, now) && stats.disabledReason && FAILURE_REASON_SET.has(stats.disabledReason)) {
			addScore(stats.disabledReason, 1e3);
			continue;
		}
		if (isActiveUnusableWindow(stats.blockedUntil, now)) {
			addScore("rate_limit", 1e3);
			continue;
		}
		if (!isActiveUnusableWindow(stats.cooldownUntil, now)) continue;
		let recordedReason = false;
		for (const [rawReason, rawCount] of Object.entries(stats.failureCounts ?? {})) {
			const reason = rawReason;
			const count = typeof rawCount === "number" ? rawCount : 0;
			if (!FAILURE_REASON_SET.has(reason) || count <= 0) continue;
			addScore(reason, count);
			recordedReason = true;
		}
		if (!recordedReason) addScore("unknown", 1);
	}
	if (scores.size === 0) return null;
	let best = null;
	let bestScore = -1;
	let bestPriority = Number.MAX_SAFE_INTEGER;
	for (const reason of FAILURE_REASON_PRIORITY) {
		const score = scores.get(reason);
		if (typeof score !== "number") continue;
		const priority = FAILURE_REASON_ORDER.get(reason) ?? Number.MAX_SAFE_INTEGER;
		if (score > bestScore || score === bestScore && priority < bestPriority) {
			best = reason;
			bestScore = score;
			bestPriority = priority;
		}
	}
	return best;
}
function calculateAuthProfileCooldownMs(errorCount) {
	const normalized = Math.max(1, errorCount);
	if (normalized <= 1) return 3e4;
	if (normalized <= 2) return 6e4;
	return 5 * 6e4;
}
const DISABLED_FAILURE_BACKOFF_POLICIES = {
	billing: {
		baseMs: (cfg) => cfg.billingBackoffMs,
		maxMs: (cfg) => cfg.billingMaxMs
	},
	auth_permanent: {
		baseMs: (cfg) => cfg.authPermanentBackoffMs,
		maxMs: (cfg) => cfg.authPermanentMaxMs
	}
};
function resolveAuthCooldownConfig(params) {
	const defaults = {
		billingBackoffHours: 5,
		billingMaxHours: 24,
		authPermanentBackoffMinutes: 10,
		authPermanentMaxMinutes: 60,
		failureWindowHours: 24
	};
	const resolvePositiveNumber = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
	const cooldowns = params.cfg?.auth?.cooldowns;
	const billingBackoffHours = resolvePositiveNumber((() => {
		const map = cooldowns?.billingBackoffHoursByProvider;
		if (!map) return;
		for (const [key, value] of Object.entries(map)) if (normalizeProviderId(key) === params.providerId) return value;
	})() ?? cooldowns?.billingBackoffHours, defaults.billingBackoffHours);
	const billingMaxHours = resolvePositiveNumber(cooldowns?.billingMaxHours, defaults.billingMaxHours);
	const authPermanentBackoffMinutes = resolvePositiveNumber(cooldowns?.authPermanentBackoffMinutes, defaults.authPermanentBackoffMinutes);
	const authPermanentMaxMinutes = resolvePositiveNumber(cooldowns?.authPermanentMaxMinutes, defaults.authPermanentMaxMinutes);
	const failureWindowHours = resolvePositiveNumber(cooldowns?.failureWindowHours, defaults.failureWindowHours);
	return {
		billingBackoffMs: billingBackoffHours * 60 * 60 * 1e3,
		billingMaxMs: billingMaxHours * 60 * 60 * 1e3,
		authPermanentBackoffMs: authPermanentBackoffMinutes * 60 * 1e3,
		authPermanentMaxMs: authPermanentMaxMinutes * 60 * 1e3,
		failureWindowMs: failureWindowHours * 60 * 60 * 1e3
	};
}
function calculateDisabledLaneBackoffMs(params) {
	const normalized = Math.max(1, params.errorCount);
	const baseMs = Math.max(6e4, params.baseMs);
	const maxMs = Math.max(baseMs, params.maxMs);
	const raw = baseMs * 2 ** Math.min(normalized - 1, 10);
	return Math.min(maxMs, raw);
}
function resolveDisabledFailureBackoffMs(params) {
	const policy = DISABLED_FAILURE_BACKOFF_POLICIES[params.reason];
	return calculateDisabledLaneBackoffMs({
		errorCount: params.errorCount,
		baseMs: policy.baseMs(params.cfgResolved),
		maxMs: policy.maxMs(params.cfgResolved)
	});
}
function resolveProfileUnusableUntilForDisplay(store, profileId) {
	if (isAuthCooldownBypassedForProvider(store.profiles[profileId]?.provider)) return null;
	const stats = store.usageStats?.[profileId];
	if (!stats) return null;
	return resolveProfileUnusableUntil(stats);
}
function resetUsageStats(existing, overrides) {
	return {
		...existing,
		errorCount: 0,
		blockedUntil: void 0,
		blockedReason: void 0,
		blockedSource: void 0,
		blockedModel: void 0,
		cooldownUntil: void 0,
		cooldownReason: void 0,
		cooldownModel: void 0,
		disabledUntil: void 0,
		disabledReason: void 0,
		failureCounts: void 0,
		...overrides
	};
}
function updateUsageStatsEntry(store, profileId, updater) {
	store.usageStats = store.usageStats ?? {};
	store.usageStats[profileId] = updater(store.usageStats[profileId]);
}
function keepActiveWindowOrRecompute(params) {
	const { existingUntil, now, recomputedUntil } = params;
	return typeof existingUntil === "number" && Number.isFinite(existingUntil) && existingUntil > now ? existingUntil : recomputedUntil;
}
function computeNextProfileUsageStats(params) {
	const windowMs = params.cfgResolved.failureWindowMs;
	const windowExpired = typeof params.existing.lastFailureAt === "number" && params.existing.lastFailureAt > 0 && params.now - params.existing.lastFailureAt > windowMs;
	const unusableUntil = resolveProfileUnusableUntil(params.existing);
	const previousCooldownExpired = typeof unusableUntil === "number" && params.now >= unusableUntil;
	const shouldResetCounters = windowExpired || previousCooldownExpired;
	const nextErrorCount = (shouldResetCounters ? 0 : params.existing.errorCount ?? 0) + 1;
	const failureCounts = shouldResetCounters ? {} : { ...params.existing.failureCounts };
	failureCounts[params.reason] = (failureCounts[params.reason] ?? 0) + 1;
	const updatedStats = {
		...params.existing,
		errorCount: nextErrorCount,
		failureCounts,
		lastFailureAt: params.now
	};
	const disabledFailureReason = params.reason === "billing" || params.reason === "auth_permanent" ? params.reason : null;
	if (disabledFailureReason) {
		const backoffMs = resolveDisabledFailureBackoffMs({
			reason: disabledFailureReason,
			errorCount: failureCounts[disabledFailureReason] ?? 1,
			cfgResolved: params.cfgResolved
		});
		updatedStats.disabledUntil = keepActiveWindowOrRecompute({
			existingUntil: params.existing.disabledUntil,
			now: params.now,
			recomputedUntil: params.now + backoffMs
		});
		updatedStats.disabledReason = disabledFailureReason;
	} else {
		const backoffMs = calculateAuthProfileCooldownMs(nextErrorCount);
		updatedStats.cooldownUntil = keepActiveWindowOrRecompute({
			existingUntil: params.existing.cooldownUntil,
			now: params.now,
			recomputedUntil: params.now + backoffMs
		});
		if (typeof params.existing.cooldownUntil === "number" && params.existing.cooldownUntil > params.now) {
			updatedStats.cooldownReason = params.reason;
			if (params.existing.cooldownModel && params.modelId && params.existing.cooldownModel !== params.modelId) updatedStats.cooldownModel = void 0;
			else if (params.reason === "rate_limit" && !params.modelId && params.existing.cooldownModel) updatedStats.cooldownModel = void 0;
			else if (params.reason !== "rate_limit") updatedStats.cooldownModel = void 0;
			else updatedStats.cooldownModel = params.existing.cooldownModel;
		} else {
			updatedStats.cooldownReason = params.reason;
			updatedStats.cooldownModel = params.reason === "rate_limit" ? params.modelId : void 0;
		}
	}
	return updatedStats;
}
/**
* Mark a profile as failed for a specific reason. Billing and permanent-auth
* failures are treated as "disabled" (longer backoff) vs the regular cooldown
* window.
*/
async function markAuthProfileFailure(params) {
	const { store, profileId, reason, agentDir, cfg, runId, modelId } = params;
	const profile = store.profiles[profileId];
	if (!profile || isAuthCooldownBypassedForProvider(profile.provider)) return;
	const whamResult = shouldProbeWhamForFailure(profile.provider, reason) ? await probeWhamForCooldown(store, profileId) : null;
	let nextStats;
	let previousStats;
	let updateTime = 0;
	const updated = await authProfileUsageDeps.updateAuthProfileStoreWithLock({
		agentDir,
		updater: (freshStore) => {
			const profile = freshStore.profiles[profileId];
			if (!profile || isAuthCooldownBypassedForProvider(profile.provider)) return false;
			const now = Date.now();
			const cfgResolved = resolveAuthCooldownConfig({
				cfg,
				providerId: normalizeProviderId(profile.provider)
			});
			previousStats = freshStore.usageStats?.[profileId];
			updateTime = now;
			const computed = computeNextProfileUsageStats({
				existing: previousStats ?? {},
				now,
				reason,
				cfgResolved,
				modelId
			});
			nextStats = whamResult && shouldProbeWhamForFailure(profile.provider, reason) ? applyWhamCooldownResult({
				existing: previousStats ?? {},
				computed,
				now,
				whamResult
			}) : computed;
			updateUsageStatsEntry(freshStore, profileId, () => nextStats ?? computed);
			return true;
		}
	});
	if (updated) {
		store.usageStats = updated.usageStats;
		if (nextStats) logAuthProfileFailureStateChange({
			runId,
			profileId,
			provider: profile.provider,
			reason,
			previous: previousStats,
			next: nextStats,
			now: updateTime
		});
		try {
			onAuthProfileFailureHook?.();
		} catch (err) {
			authProfileUsageLog.warn("auth profile failure hook threw", {
				event: "auth_profile_failure_hook_error",
				tags: ["error_handling", "auth_profiles"],
				error: err instanceof Error ? err.message : String(err)
			});
		}
		return;
	}
	if (!store.profiles[profileId]) return;
	const now = Date.now();
	const cfgResolved = resolveAuthCooldownConfig({
		cfg,
		providerId: normalizeProviderId(store.profiles[profileId]?.provider ?? "")
	});
	previousStats = store.usageStats?.[profileId];
	const computed = computeNextProfileUsageStats({
		existing: previousStats ?? {},
		now,
		reason,
		cfgResolved,
		modelId
	});
	nextStats = whamResult && shouldProbeWhamForFailure(store.profiles[profileId]?.provider, reason) ? applyWhamCooldownResult({
		existing: previousStats ?? {},
		computed,
		now,
		whamResult
	}) : computed;
	updateUsageStatsEntry(store, profileId, () => nextStats ?? computed);
	authProfileUsageDeps.saveAuthProfileStore(store, agentDir);
	logAuthProfileFailureStateChange({
		runId,
		profileId,
		provider: store.profiles[profileId]?.provider ?? profile.provider,
		reason,
		previous: previousStats,
		next: nextStats,
		now
	});
	try {
		onAuthProfileFailureHook?.();
	} catch (err) {
		authProfileUsageLog.warn("auth profile failure hook threw", {
			event: "auth_profile_failure_hook_error",
			tags: ["error_handling", "auth_profiles"],
			error: err instanceof Error ? err.message : String(err)
		});
	}
}
async function markAuthProfileBlockedUntil(params) {
	const { store, profileId, blockedUntil, agentDir, runId, modelId, source } = params;
	const profile = store.profiles[profileId];
	if (!profile || isAuthCooldownBypassedForProvider(profile.provider) || !Number.isFinite(blockedUntil) || blockedUntil <= Date.now()) return;
	let nextStats;
	let previousStats;
	let updateTime = 0;
	const updated = await authProfileUsageDeps.updateAuthProfileStoreWithLock({
		agentDir,
		updater: (freshStore) => {
			const profile = freshStore.profiles[profileId];
			if (!profile || isAuthCooldownBypassedForProvider(profile.provider)) return false;
			const now = Date.now();
			previousStats = freshStore.usageStats?.[profileId];
			updateTime = now;
			const existingBlockedUntil = previousStats?.blockedUntil;
			const activeBlockedUntil = typeof existingBlockedUntil === "number" && Number.isFinite(existingBlockedUntil) && existingBlockedUntil > now ? existingBlockedUntil : 0;
			nextStats = {
				...previousStats,
				blockedUntil: Math.max(activeBlockedUntil, blockedUntil),
				blockedReason: "subscription_limit",
				blockedSource: source,
				blockedModel: modelId,
				cooldownUntil: void 0,
				cooldownReason: void 0,
				cooldownModel: void 0,
				lastFailureAt: now,
				failureCounts: {
					...previousStats?.failureCounts,
					rate_limit: (previousStats?.failureCounts?.rate_limit ?? 0) + 1
				}
			};
			updateUsageStatsEntry(freshStore, profileId, () => nextStats);
			return true;
		}
	});
	if (updated) {
		store.usageStats = updated.usageStats;
		if (nextStats) logAuthProfileFailureStateChange({
			runId,
			profileId,
			provider: profile.provider,
			reason: "rate_limit",
			previous: previousStats,
			next: nextStats,
			now: updateTime
		});
		return;
	}
	if (!store.profiles[profileId]) return;
	const now = Date.now();
	previousStats = store.usageStats?.[profileId];
	const existingBlockedUntil = previousStats?.blockedUntil;
	const activeBlockedUntil = typeof existingBlockedUntil === "number" && Number.isFinite(existingBlockedUntil) && existingBlockedUntil > now ? existingBlockedUntil : 0;
	nextStats = {
		...previousStats,
		blockedUntil: Math.max(activeBlockedUntil, blockedUntil),
		blockedReason: "subscription_limit",
		blockedSource: source,
		blockedModel: modelId,
		cooldownUntil: void 0,
		cooldownReason: void 0,
		cooldownModel: void 0,
		lastFailureAt: now,
		failureCounts: {
			...previousStats?.failureCounts,
			rate_limit: (previousStats?.failureCounts?.rate_limit ?? 0) + 1
		}
	};
	updateUsageStatsEntry(store, profileId, () => nextStats);
	authProfileUsageDeps.saveAuthProfileStore(store, agentDir);
	logAuthProfileFailureStateChange({
		runId,
		profileId,
		provider: store.profiles[profileId]?.provider ?? profile.provider,
		reason: "rate_limit",
		previous: previousStats,
		next: nextStats,
		now
	});
}
/**
* Mark a profile as transiently failed. Applies stepped backoff cooldown.
* Cooldown times: 30s, 1min, 5min (capped).
* Uses store lock to avoid overwriting concurrent usage updates.
*/
async function markAuthProfileCooldown(params) {
	await markAuthProfileFailure({
		store: params.store,
		profileId: params.profileId,
		reason: "unknown",
		agentDir: params.agentDir,
		runId: params.runId
	});
}
/**
* Clear cooldown for a profile (e.g., manual reset).
* Uses store lock to avoid overwriting concurrent usage updates.
*/
async function clearAuthProfileCooldown(params) {
	const { store, profileId, agentDir } = params;
	const updated = await authProfileUsageDeps.updateAuthProfileStoreWithLock({
		agentDir,
		updater: (freshStore) => {
			if (!freshStore.usageStats?.[profileId]) return false;
			updateUsageStatsEntry(freshStore, profileId, (existing) => resetUsageStats(existing));
			return true;
		}
	});
	if (updated) {
		store.usageStats = updated.usageStats;
		return;
	}
	if (!store.usageStats?.[profileId]) return;
	updateUsageStatsEntry(store, profileId, (existing) => resetUsageStats(existing));
	authProfileUsageDeps.saveAuthProfileStore(store, agentDir);
}
//#endregion
export { markAuthProfileFailure as a, setAuthProfileFailureHook as c, markAuthProfileCooldown as i, clearAuthProfileCooldown as n, resolveProfileUnusableUntilForDisplay as o, markAuthProfileBlockedUntil as r, resolveProfilesUnavailableReason as s, calculateAuthProfileCooldownMs as t };
