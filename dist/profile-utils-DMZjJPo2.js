//#region src/cli/profile-utils.ts
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
function isValidProfileName(value) {
	if (!value) return false;
	return PROFILE_NAME_RE.test(value);
}
function normalizeProfileName(raw) {
	const profile = raw?.trim();
	if (!profile) return null;
	if (profile.toLowerCase() === "default") return null;
	if (!isValidProfileName(profile)) return null;
	return profile;
}

//#endregion
export { normalizeProfileName as n, isValidProfileName as t };