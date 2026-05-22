import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
export { dedupeProfileIds, listProfilesForProvider } from "./profile-list.js";
export declare function setAuthProfileOrder(params: {
    agentDir?: string;
    provider: string;
    order?: string[] | null;
}): Promise<AuthProfileStore | null>;
export declare function promoteAuthProfileInOrder(params: {
    agentDir?: string;
    provider: string;
    profileId: string;
}): Promise<AuthProfileStore | null>;
export declare function upsertAuthProfile(params: {
    profileId: string;
    credential: AuthProfileCredential;
    agentDir?: string;
}): void;
export declare function upsertAuthProfileWithLock(params: {
    profileId: string;
    credential: AuthProfileCredential;
    agentDir?: string;
}): Promise<AuthProfileStore | null>;
export declare function removeProviderAuthProfilesWithLock(params: {
    provider: string;
    agentDir?: string;
}): Promise<AuthProfileStore | null>;
export declare function markAuthProfileGood(params: {
    store: AuthProfileStore;
    provider: string;
    profileId: string;
    agentDir?: string;
}): Promise<void>;
