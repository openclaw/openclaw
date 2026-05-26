import { n as findNormalizedProviderValue, r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
import { M as evaluateStoredCredentialEligibility } from "./store-BMQkMM4l.js";
import { n as listProfilesForProvider, t as dedupeProfileIds } from "./profile-list-C0HtPlut.js";
//#region src/agents/auth-profiles/usage-state.ts
function isAuthCooldownBypassedForProvider(provider) {
	const normalized = normalizeProviderId(provider ?? "");
	return normalized === "openrouter" || normalized === "kilocode";
}
function resolveProfileUnusableUntil(stats) {
	const values = [
		stats.blockedUntil,
		stats.cooldownUntil,
		stats.disabledUntil
	].filter((value) => typeof value === "number").filter((value) => Number.isFinite(value) && value > 0);
	if (values.length === 0) return null;
	return Math.max(...values);
}
function isActiveUnusableWindow(until, now) {
	return typeof until === "number" && Number.isFinite(until) && until > 0 && now < until;
}
function shouldBypassModelScopedCooldown(stats, now, forModel) {
	return !!(forModel && stats.cooldownReason === "rate_limit" && stats.cooldownModel && stats.cooldownModel !== forModel && !isActiveUnusableWindow(stats.disabledUntil, now));
}
/**
* Check if a profile is currently in cooldown (due to rate limits, overload, or other transient failures).
*/
function isProfileInCooldown(store, profileId, now, forModel) {
	if (isAuthCooldownBypassedForProvider(store.profiles[profileId]?.provider)) return false;
	const stats = store.usageStats?.[profileId];
	if (!stats) return false;
	const ts = now ?? Date.now();
	if (shouldBypassModelScopedCooldown(stats, ts, forModel)) return false;
	const unusableUntil = resolveProfileUnusableUntil(stats);
	return unusableUntil ? ts < unusableUntil : false;
}
/**
* Return the soonest `unusableUntil` timestamp (ms epoch) among the given
* profiles, or `null` when no profile has a recorded cooldown. Note: the
* returned timestamp may be in the past if the cooldown has already expired.
*/
function getSoonestCooldownExpiry(store, profileIds, options) {
	const ts = options?.now ?? Date.now();
	let soonest = null;
	let latestMatchingModelCooldown = null;
	for (const id of profileIds) {
		const stats = store.usageStats?.[id];
		if (!stats) continue;
		if (shouldBypassModelScopedCooldown(stats, ts, options?.forModel)) continue;
		const until = resolveProfileUnusableUntil(stats);
		if (typeof until !== "number" || !Number.isFinite(until) || until <= 0) continue;
		if (options?.forModel && stats.cooldownReason === "rate_limit" && stats.cooldownModel === options.forModel && !isActiveUnusableWindow(stats.disabledUntil, ts)) {
			latestMatchingModelCooldown = latestMatchingModelCooldown === null ? until : Math.max(latestMatchingModelCooldown, until);
			continue;
		}
		if (soonest === null || until < soonest) soonest = until;
	}
	if (soonest === null) return latestMatchingModelCooldown;
	if (latestMatchingModelCooldown === null) return soonest;
	return Math.min(soonest, latestMatchingModelCooldown);
}
/**
* Clear expired cooldowns from all profiles in the store.
*
* When `cooldownUntil` or `disabledUntil` has passed, the corresponding fields
* are removed and error counters are reset so the profile gets a fresh start
* (circuit-breaker half-open -> closed). Without this, a stale `errorCount`
* causes the *next* transient failure to immediately escalate to a much longer
* cooldown -- the root cause of profiles appearing "stuck" after rate limits.
*
* `cooldownUntil` and `disabledUntil` are handled independently: if a profile
* has both and only one has expired, only that field is cleared.
*
* Mutates the in-memory store; disk persistence happens lazily on the next
* store write (e.g. `markAuthProfileSuccess` / `markAuthProfileFailure`), which
* matches the existing save pattern throughout the auth-profiles module.
*
* @returns `true` if any profile was modified.
*/
function clearExpiredCooldowns(store, now) {
	const usageStats = store.usageStats;
	if (!usageStats) return false;
	const ts = now ?? Date.now();
	let mutated = false;
	for (const [profileId, stats] of Object.entries(usageStats)) {
		if (!stats) continue;
		let profileMutated = false;
		const cooldownExpired = typeof stats.cooldownUntil === "number" && Number.isFinite(stats.cooldownUntil) && stats.cooldownUntil > 0 && ts >= stats.cooldownUntil;
		const blockedExpired = typeof stats.blockedUntil === "number" && Number.isFinite(stats.blockedUntil) && stats.blockedUntil > 0 && ts >= stats.blockedUntil;
		const disabledExpired = typeof stats.disabledUntil === "number" && Number.isFinite(stats.disabledUntil) && stats.disabledUntil > 0 && ts >= stats.disabledUntil;
		if (cooldownExpired) {
			stats.cooldownUntil = void 0;
			stats.cooldownReason = void 0;
			stats.cooldownModel = void 0;
			profileMutated = true;
		}
		if (blockedExpired) {
			stats.blockedUntil = void 0;
			stats.blockedReason = void 0;
			stats.blockedSource = void 0;
			stats.blockedModel = void 0;
			profileMutated = true;
		}
		if (disabledExpired) {
			stats.disabledUntil = void 0;
			stats.disabledReason = void 0;
			profileMutated = true;
		}
		if (profileMutated && !resolveProfileUnusableUntil(stats)) {
			stats.errorCount = 0;
			stats.failureCounts = void 0;
		}
		if (profileMutated) {
			usageStats[profileId] = stats;
			mutated = true;
		}
	}
	return mutated;
}
//#endregion
//#region src/agents/auth-profiles/order.ts
const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
function isOpenAIApiKeyCompatibleWithCodexAuth(params) {
	if (params.providerAuthKey !== OPENAI_CODEX_PROVIDER_ID) return false;
	const providerKey = resolveProviderIdForAuth(params.profileProvider ?? "", { config: params.cfg });
	const mode = params.credential?.type ?? params.profileMode;
	return providerKey === OPENAI_PROVIDER_ID && mode === "api_key";
}
function isCredentialProviderCompatibleWithAuthProvider(params) {
	return resolveProviderIdForAuth(params.credential.provider, { config: params.cfg }) === params.providerAuthKey || isOpenAIApiKeyCompatibleWithCodexAuth({
		cfg: params.cfg,
		providerAuthKey: params.providerAuthKey,
		credential: params.credential,
		profileProvider: params.credential.provider
	});
}
function isStoredCredentialCompatibleWithAuthProvider(params) {
	return isCredentialProviderCompatibleWithAuthProvider({
		cfg: params.cfg,
		providerAuthKey: resolveProviderIdForAuth(params.provider, { config: params.cfg }),
		credential: params.credential
	});
}
function isConfiguredProfileCompatibleWithAuthProvider(params) {
	return resolveProviderIdForAuth(params.provider, { config: params.cfg }) === params.providerAuthKey || isOpenAIApiKeyCompatibleWithCodexAuth({
		cfg: params.cfg,
		providerAuthKey: params.providerAuthKey,
		credential: params.credential,
		profileProvider: params.provider,
		profileMode: params.mode
	});
}
function listProfilesCompatibleWithAuthProvider(params) {
	if (params.providerAuthKey !== OPENAI_CODEX_PROVIDER_ID) return listProfilesForProvider(params.store, params.provider);
	return Object.entries(params.store.profiles).filter(([, credential]) => isCredentialProviderCompatibleWithAuthProvider({
		cfg: params.cfg,
		providerAuthKey: params.providerAuthKey,
		credential
	})).map(([profileId]) => profileId);
}
function resolveProviderAuthMode(cfg, provider) {
	const providers = cfg?.models?.providers;
	if (!providers) return;
	const auth = findNormalizedProviderValue(providers, provider)?.auth;
	return typeof auth === "string" ? auth : void 0;
}
function providerAllowsAwsSdkAuth(cfg, provider) {
	const authMode = resolveProviderAuthMode(cfg, provider);
	return authMode === "aws-sdk" || authMode === void 0 && normalizeProviderId(provider) === "amazon-bedrock";
}
function isConfiguredAwsSdkAuthProfileForProvider(params) {
	const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
	if (!profileConfig || profileConfig.mode !== "aws-sdk") return false;
	const providerAuthKey = resolveProviderIdForAuth(params.provider, { config: params.cfg });
	if (resolveProviderIdForAuth(profileConfig.provider, { config: params.cfg }) !== providerAuthKey) return false;
	return providerAllowsAwsSdkAuth(params.cfg, params.provider);
}
function resolveAuthProfileEligibility(params) {
	const providerAuthKey = resolveProviderIdForAuth(params.provider, { config: params.cfg });
	const cred = params.store.profiles[params.profileId];
	if (!cred) {
		if (isConfiguredAwsSdkAuthProfileForProvider({
			cfg: params.cfg,
			provider: params.provider,
			profileId: params.profileId
		})) return {
			eligible: true,
			reasonCode: "ok"
		};
		return {
			eligible: false,
			reasonCode: "profile_missing"
		};
	}
	if (!isCredentialProviderCompatibleWithAuthProvider({
		cfg: params.cfg,
		providerAuthKey,
		credential: cred
	})) return {
		eligible: false,
		reasonCode: "provider_mismatch"
	};
	const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
	if (profileConfig) {
		if (!isConfiguredProfileCompatibleWithAuthProvider({
			cfg: params.cfg,
			providerAuthKey,
			provider: profileConfig.provider,
			mode: profileConfig.mode,
			credential: cred
		})) return {
			eligible: false,
			reasonCode: "provider_mismatch"
		};
		if (profileConfig.mode !== cred.type) {
			if (!(profileConfig.mode === "oauth" && cred.type === "token")) return {
				eligible: false,
				reasonCode: "mode_mismatch"
			};
		}
	}
	const credentialEligibility = evaluateStoredCredentialEligibility({
		credential: cred,
		now: params.now
	});
	return {
		eligible: credentialEligibility.eligible,
		reasonCode: credentialEligibility.reasonCode
	};
}
function resolveAuthProfileOrder(params) {
	const { cfg, store, provider, preferredProfile } = params;
	const providerKey = normalizeProviderId(provider);
	const providerAuthKey = resolveProviderIdForAuth(provider, { config: cfg });
	const now = Date.now();
	clearExpiredCooldowns(store, now);
	const openAIOrderAliasProvider = providerAuthKey === OPENAI_CODEX_PROVIDER_ID || providerKey === OPENAI_CODEX_PROVIDER_ID ? OPENAI_PROVIDER_ID : void 0;
	const directStoredOrder = resolveAuthOrder(store.order, providerAuthKey) ?? resolveAuthOrder(store.order, providerKey);
	const aliasStoredOrder = openAIOrderAliasProvider ? resolveAuthOrder(store.order, openAIOrderAliasProvider) : void 0;
	const directConfiguredOrder = resolveAuthOrder(cfg?.auth?.order, providerAuthKey) ?? resolveAuthOrder(cfg?.auth?.order, providerKey);
	const aliasConfiguredOrder = openAIOrderAliasProvider ? resolveAuthOrder(cfg?.auth?.order, openAIOrderAliasProvider) : void 0;
	const directExplicitOrder = directStoredOrder ?? directConfiguredOrder;
	const aliasExplicitOrder = aliasStoredOrder ?? aliasConfiguredOrder;
	const explicitProfiles = cfg?.auth?.profiles ? Object.entries(cfg.auth.profiles).filter(([profileId, profile]) => isConfiguredProfileCompatibleWithAuthProvider({
		cfg,
		providerAuthKey,
		provider: profile.provider,
		mode: profile.mode,
		credential: store.profiles[profileId]
	})).map(([profileId]) => profileId) : [];
	const storeProfiles = listProfilesCompatibleWithAuthProvider({
		cfg,
		store,
		provider,
		providerAuthKey
	});
	const nativeStoreProfiles = openAIOrderAliasProvider && providerAuthKey === OPENAI_CODEX_PROVIDER_ID ? storeProfiles.filter((profileId) => isNativeCredentialProviderCompatibleWithAuthProvider({
		cfg,
		providerAuthKey,
		credential: store.profiles[profileId]
	})) : [];
	const explicitOrder = directExplicitOrder ?? (aliasExplicitOrder ? mergeAliasOrderWithNativeProfiles({
		aliasOrder: aliasExplicitOrder,
		nativeProfiles: nativeStoreProfiles
	}) : void 0);
	const baseOrder = explicitOrder ?? (explicitProfiles.length > 0 ? explicitProfiles : storeProfiles);
	if (baseOrder.length === 0) return [];
	const isValidProfile = (profileId) => resolveAuthProfileEligibility({
		cfg,
		store,
		provider,
		profileId,
		now
	}).eligible;
	let filtered = baseOrder.filter(isValidProfile);
	const allBaseProfilesMissing = baseOrder.every((profileId) => !store.profiles[profileId]);
	if (filtered.length === 0 && explicitProfiles.length > 0 && allBaseProfilesMissing) filtered = storeProfiles.filter(isValidProfile);
	const deduped = dedupeProfileIds(filtered);
	if (explicitOrder && explicitOrder.length > 0) {
		const available = [];
		const inCooldown = [];
		for (const profileId of deduped) if (isProfileInCooldown(store, profileId)) {
			const cooldownUntil = resolveProfileUnusableUntil(store.usageStats?.[profileId] ?? {}) ?? now;
			inCooldown.push({
				profileId,
				cooldownUntil
			});
		} else available.push(profileId);
		const cooldownSorted = inCooldown.toSorted((a, b) => a.cooldownUntil - b.cooldownUntil).map((entry) => entry.profileId);
		const ordered = [...available, ...cooldownSorted];
		if (preferredProfile && ordered.includes(preferredProfile)) return [preferredProfile, ...ordered.filter((e) => e !== preferredProfile)];
		return ordered;
	}
	const sorted = orderProfilesByMode(deduped, store);
	if (preferredProfile && sorted.includes(preferredProfile)) return [preferredProfile, ...sorted.filter((e) => e !== preferredProfile)];
	return sorted;
}
function resolveAuthOrder(order, provider) {
	return findNormalizedProviderValue(order, provider);
}
function isNativeCredentialProviderCompatibleWithAuthProvider(params) {
	if (!params.credential) return false;
	return resolveProviderIdForAuth(params.credential.provider, { config: params.cfg }) === params.providerAuthKey;
}
function mergeAliasOrderWithNativeProfiles(params) {
	const nativeIds = new Set(params.nativeProfiles);
	return dedupeProfileIds(params.aliasOrder.some((profileId) => nativeIds.has(profileId)) ? [...params.aliasOrder, ...params.nativeProfiles] : [...params.nativeProfiles, ...params.aliasOrder]);
}
function orderProfilesByMode(order, store) {
	const now = Date.now();
	const available = [];
	const inCooldown = [];
	for (const profileId of order) if (isProfileInCooldown(store, profileId)) inCooldown.push(profileId);
	else available.push(profileId);
	const sorted = available.map((profileId) => {
		const type = store.profiles[profileId]?.type;
		return {
			profileId,
			typeScore: type === "oauth" ? 0 : type === "token" ? 1 : type === "api_key" ? 2 : 3,
			lastUsed: store.usageStats?.[profileId]?.lastUsed ?? 0
		};
	}).toSorted((a, b) => {
		if (a.typeScore !== b.typeScore) return a.typeScore - b.typeScore;
		return a.lastUsed - b.lastUsed;
	}).map((entry) => entry.profileId);
	const cooldownSorted = inCooldown.map((profileId) => ({
		profileId,
		cooldownUntil: resolveProfileUnusableUntil(store.usageStats?.[profileId] ?? {}) ?? now
	})).toSorted((a, b) => a.cooldownUntil - b.cooldownUntil).map((entry) => entry.profileId);
	return [...sorted, ...cooldownSorted];
}
//#endregion
export { clearExpiredCooldowns as a, isAuthCooldownBypassedForProvider as c, resolveAuthProfileOrder as i, isProfileInCooldown as l, isStoredCredentialCompatibleWithAuthProvider as n, getSoonestCooldownExpiry as o, resolveAuthProfileEligibility as r, isActiveUnusableWindow as s, isConfiguredAwsSdkAuthProfileForProvider as t, resolveProfileUnusableUntil as u };
