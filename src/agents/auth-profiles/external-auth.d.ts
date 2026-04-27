import { resolveExternalAuthProfilesWithPlugins } from "../../plugins/provider-runtime.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";
type ResolveExternalAuthProfiles = typeof resolveExternalAuthProfilesWithPlugins;
export declare const __testing: {
    resetResolveExternalAuthProfilesForTest(): void;
    setResolveExternalAuthProfilesForTest(resolver: ResolveExternalAuthProfiles): void;
};
export declare function overlayExternalAuthProfiles(store: AuthProfileStore, params?: {
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
}): AuthProfileStore;
export declare function shouldPersistExternalAuthProfile(params: {
    store: AuthProfileStore;
    profileId: string;
    credential: OAuthCredential;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
}): boolean;
export declare const overlayExternalOAuthProfiles: typeof overlayExternalAuthProfiles;
export declare const shouldPersistExternalOAuthProfile: typeof shouldPersistExternalAuthProfile;
export {};
