import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
export declare function dedupeProfileIds(profileIds: string[]): string[];
export declare function setAuthProfileOrder(params: {
    agentDir?: string;
    provider: string;
    order?: string[] | null;
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
export declare function listProfilesForProvider(store: AuthProfileStore, provider: string): string[];
export declare function markAuthProfileGood(params: {
    store: AuthProfileStore;
    provider: string;
    profileId: string;
    agentDir?: string;
}): Promise<void>;
