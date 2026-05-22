import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveExternalAuthProfilesWithPlugins } from "../../plugins/provider-runtime.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";
type ResolveExternalAuthProfiles = typeof resolveExternalAuthProfilesWithPlugins;
type ExternalCliOverlayOptions = {
    allowKeychainPrompt?: boolean;
    config?: OpenClawConfig;
    externalCliProviderIds?: Iterable<string>;
    externalCliProfileIds?: Iterable<string>;
};
export declare const __testing: {
    resetResolveExternalAuthProfilesForTest(): void;
    setResolveExternalAuthProfilesForTest(resolver: ResolveExternalAuthProfiles): void;
};
export declare function overlayExternalAuthProfiles(store: AuthProfileStore, params?: {
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
} & ExternalCliOverlayOptions): AuthProfileStore;
export declare function shouldPersistExternalAuthProfile(params: {
    store: AuthProfileStore;
    profileId: string;
    credential: OAuthCredential;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
    config?: OpenClawConfig;
    externalCliProviderIds?: Iterable<string>;
    externalCliProfileIds?: Iterable<string>;
}): boolean;
export declare const overlayExternalOAuthProfiles: typeof overlayExternalAuthProfiles;
export declare const shouldPersistExternalOAuthProfile: typeof shouldPersistExternalAuthProfile;
export {};
