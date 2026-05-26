import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { t as hasAnyAuthProfileStoreSource } from "./source-check-BMw3fGLx.js";
import { i as resolveAuthProfileOrder, l as isProfileInCooldown, n as isStoredCredentialCompatibleWithAuthProvider, t as isConfiguredAwsSdkAuthProfileForProvider } from "./order-DJrj83KE.js";
import "./usage-DbhCKKrr.js";
//#region src/agents/auth-profiles/session-override.ts
const sessionStoreRuntimeLoader = createLazyImportLoader(() => import("./store.runtime.js"));
function loadSessionStoreRuntime() {
	return sessionStoreRuntimeLoader.load();
}
function isProfileForProvider(params) {
	const entry = params.store.profiles[params.profileId];
	if (entry) {
		if (!entry.provider) return false;
		return params.providers.some((provider) => isStoredCredentialCompatibleWithAuthProvider({
			cfg: params.cfg,
			provider,
			credential: entry
		}));
	}
	return params.providers.some((provider) => isConfiguredAwsSdkAuthProfileForProvider({
		cfg: params.cfg,
		provider,
		profileId: params.profileId
	}));
}
function uniqueProviders(provider, acceptedProviderIds) {
	const providers = /* @__PURE__ */ new Set();
	const push = (value) => {
		const normalized = value?.trim();
		if (normalized) providers.add(normalized);
	};
	(acceptedProviderIds && acceptedProviderIds.length > 0 ? acceptedProviderIds : [provider]).forEach(push);
	return [...providers];
}
async function clearSessionAuthProfileOverride(params) {
	const { sessionEntry, sessionStore, sessionKey, storePath } = params;
	delete sessionEntry.authProfileOverride;
	delete sessionEntry.authProfileOverrideSource;
	delete sessionEntry.authProfileOverrideCompactionCount;
	sessionEntry.updatedAt = Date.now();
	sessionStore[sessionKey] = sessionEntry;
	if (storePath) await (await loadSessionStoreRuntime()).updateSessionStore(storePath, (store) => {
		store[sessionKey] = sessionEntry;
	});
}
async function resolveSessionAuthProfileOverride(params) {
	const { cfg, provider, agentDir, sessionEntry, sessionStore, sessionKey, storePath, isNewSession } = params;
	if (!sessionEntry || !sessionStore || !sessionKey) return sessionEntry?.authProfileOverride;
	const hasConfiguredAuthProfiles = Boolean(params.cfg.auth?.profiles && Object.keys(params.cfg.auth.profiles).length > 0) || Boolean(params.cfg.auth?.order && Object.keys(params.cfg.auth.order).length > 0);
	if (!sessionEntry.authProfileOverride?.trim() && !hasConfiguredAuthProfiles && !hasAnyAuthProfileStoreSource(agentDir)) return;
	const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
	const providers = uniqueProviders(provider, params.acceptedProviderIds);
	const order = [...new Set(providers.flatMap((candidateProvider) => resolveAuthProfileOrder({
		cfg,
		store,
		provider: candidateProvider
	})))];
	let current = sessionEntry.authProfileOverride?.trim();
	const source = sessionEntry.authProfileOverrideSource ?? (typeof sessionEntry.authProfileOverrideCompactionCount === "number" ? "auto" : current ? "user" : void 0);
	const currentProfileId = current;
	if (currentProfileId && !store.profiles[currentProfileId] && !providers.some((candidateProvider) => isConfiguredAwsSdkAuthProfileForProvider({
		cfg,
		provider: candidateProvider,
		profileId: currentProfileId
	}))) {
		await clearSessionAuthProfileOverride({
			sessionEntry,
			sessionStore,
			sessionKey,
			storePath
		});
		current = void 0;
	}
	if (current && !isProfileForProvider({
		cfg,
		providers,
		profileId: current,
		store
	})) {
		await clearSessionAuthProfileOverride({
			sessionEntry,
			sessionStore,
			sessionKey,
			storePath
		});
		current = void 0;
	}
	if (current && order.length > 0 && !order.includes(current) && source !== "user") {
		await clearSessionAuthProfileOverride({
			sessionEntry,
			sessionStore,
			sessionKey,
			storePath
		});
		current = void 0;
	}
	if (order.length === 0) return;
	const pickFirstAvailable = () => order.find((profileId) => !isProfileInCooldown(store, profileId)) ?? order[0];
	const pickNextAvailable = (active) => {
		const startIndex = order.indexOf(active);
		if (startIndex < 0) return pickFirstAvailable();
		for (let offset = 1; offset <= order.length; offset += 1) {
			const candidate = order[(startIndex + offset) % order.length];
			if (!isProfileInCooldown(store, candidate)) return candidate;
		}
		return order[startIndex] ?? order[0];
	};
	const compactionCount = sessionEntry.compactionCount ?? 0;
	const storedCompaction = typeof sessionEntry.authProfileOverrideCompactionCount === "number" ? sessionEntry.authProfileOverrideCompactionCount : compactionCount;
	const replacementForUnusableCurrent = current && isProfileInCooldown(store, current) ? order.find((profileId) => profileId !== current && !isProfileInCooldown(store, profileId)) : void 0;
	if (replacementForUnusableCurrent) current = void 0;
	if (source === "user" && current && !isNewSession) return current;
	let next = current;
	if (replacementForUnusableCurrent) next = replacementForUnusableCurrent;
	else if (isNewSession) next = current ? pickNextAvailable(current) : pickFirstAvailable();
	else if (current && compactionCount > storedCompaction) next = pickNextAvailable(current);
	else if (!current || isProfileInCooldown(store, current)) next = pickFirstAvailable();
	if (!next) return current;
	if (next !== sessionEntry.authProfileOverride || sessionEntry.authProfileOverrideSource !== "auto" || sessionEntry.authProfileOverrideCompactionCount !== compactionCount) {
		sessionEntry.authProfileOverride = next;
		sessionEntry.authProfileOverrideSource = "auto";
		sessionEntry.authProfileOverrideCompactionCount = compactionCount;
		sessionEntry.updatedAt = Date.now();
		sessionStore[sessionKey] = sessionEntry;
		if (storePath) await (await loadSessionStoreRuntime()).updateSessionStore(storePath, (store) => {
			store[sessionKey] = sessionEntry;
		});
	}
	return next;
}
//#endregion
export { resolveSessionAuthProfileOverride as n, clearSessionAuthProfileOverride as t };
