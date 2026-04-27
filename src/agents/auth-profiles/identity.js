import { normalizeOptionalString } from "../../shared/string-coerce.js";
function resolveStoredMetadata(store, profileId) {
    const profile = store?.profiles[profileId];
    if (!profile) {
        return {};
    }
    return {
        displayName: "displayName" in profile ? normalizeOptionalString(profile.displayName) : undefined,
        email: "email" in profile ? normalizeOptionalString(profile.email) : undefined,
    };
}
export function buildAuthProfileId(params) {
    const profilePrefix = normalizeOptionalString(params.profilePrefix) ?? params.providerId;
    const profileName = normalizeOptionalString(params.profileName) ?? "default";
    return `${profilePrefix}:${profileName}`;
}
export function resolveAuthProfileMetadata(params) {
    const configured = params.cfg?.auth?.profiles?.[params.profileId];
    const stored = resolveStoredMetadata(params.store, params.profileId);
    return {
        displayName: normalizeOptionalString(configured?.displayName) ?? stored.displayName,
        email: normalizeOptionalString(configured?.email) ?? stored.email,
    };
}
