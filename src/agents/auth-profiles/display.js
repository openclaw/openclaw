import { resolveAuthProfileMetadata } from "./identity.js";
export function resolveAuthProfileDisplayLabel(params) {
    const { displayName, email } = resolveAuthProfileMetadata(params);
    if (displayName) {
        return `${params.profileId} (${displayName})`;
    }
    if (email) {
        return `${params.profileId} (${email})`;
    }
    return params.profileId;
}
