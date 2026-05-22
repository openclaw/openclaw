import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/agents/auth-profiles/identity.ts
function resolveStoredMetadata(store, profileId) {
	const profile = store?.profiles[profileId];
	if (!profile) return {};
	return {
		displayName: "displayName" in profile ? normalizeOptionalString(profile.displayName) : void 0,
		email: "email" in profile ? normalizeOptionalString(profile.email) : void 0
	};
}
function buildAuthProfileId(params) {
	return `${normalizeOptionalString(params.profilePrefix) ?? params.providerId}:${normalizeOptionalString(params.profileName) ?? "default"}`;
}
function resolveAuthProfileMetadata(params) {
	const configured = params.cfg?.auth?.profiles?.[params.profileId];
	const stored = resolveStoredMetadata(params.store, params.profileId);
	return {
		displayName: normalizeOptionalString(configured?.displayName) ?? stored.displayName,
		email: normalizeOptionalString(configured?.email) ?? stored.email
	};
}
//#endregion
export { resolveAuthProfileMetadata as n, buildAuthProfileId as t };
