export function resolveAuthProfileDisplayLabel(params) {
    const { cfg, store, profileId } = params;
    const profile = store.profiles[profileId];
    const configEmail = cfg?.auth?.profiles?.[profileId]?.email?.trim();
    const email = configEmail || (profile && "email" in profile ? profile.email?.trim() : undefined);
    if (email) {
        return `${profileId} (${email})`;
    }
    return profileId;
}
