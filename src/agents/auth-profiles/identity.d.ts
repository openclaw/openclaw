import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "./types.js";
export declare function buildAuthProfileId(params: {
    providerId: string;
    profileName?: string | null;
    profilePrefix?: string;
}): string;
export declare function resolveAuthProfileMetadata(params: {
    cfg?: OpenClawConfig;
    store?: AuthProfileStore;
    profileId: string;
}): {
    displayName?: string;
    email?: string;
};
