import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
export declare function upsertAuthProfileWithLock(params: {
    profileId: string;
    credential: AuthProfileCredential;
    agentDir?: string;
}): Promise<AuthProfileStore | null>;
