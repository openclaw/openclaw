import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
//#region src/agents/auth-profiles/profile-list.ts
function dedupeProfileIds(profileIds) {
	return [...new Set(profileIds)];
}
function listProfilesForProvider(store, provider) {
	const providerKey = resolveProviderIdForAuth(provider);
	return Object.entries(store.profiles).filter(([, cred]) => resolveProviderIdForAuth(cred.provider) === providerKey).map(([id]) => id);
}
//#endregion
export { listProfilesForProvider as n, dedupeProfileIds as t };
