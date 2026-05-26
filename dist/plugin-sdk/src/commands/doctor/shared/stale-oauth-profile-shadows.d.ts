import type { AuthProfileStore, OAuthCredential } from "../../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
type StaleOAuthProfileShadow = {
    agentDir: string;
    authPath: string;
    profileId: string;
};
declare function shouldRemoveLocalOAuthShadow(params: {
    local: OAuthCredential;
    main: OAuthCredential | undefined;
    now: number;
}): boolean;
export declare function scanStaleOAuthProfileShadows(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    now?: number;
}): Promise<StaleOAuthProfileShadow[]>;
declare function removeStaleProfilesFromStore(params: {
    store: AuthProfileStore;
    mainStore: AuthProfileStore;
    profileIds: Set<string>;
    now: number;
}): {
    store: AuthProfileStore;
    removedProfileIds: string[];
};
declare function repairStaleOAuthProfilesForAgent(params: {
    agentDir: string;
    mainStore: AuthProfileStore;
    profileIds: Set<string>;
    now: number;
}): Promise<{
    status: "changed";
    removedProfileIds: string[];
} | {
    status: "missing" | "unchanged";
}>;
export declare function collectStaleOAuthProfileShadowWarnings(params: {
    hits: StaleOAuthProfileShadow[];
    doctorFixCommand: string;
}): string[];
export declare function repairStaleOAuthProfileShadows(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    now?: number;
}): Promise<{
    changes: string[];
    warnings: string[];
}>;
export declare const testing: {
    removeStaleProfilesFromStore: typeof removeStaleProfilesFromStore;
    repairStaleOAuthProfilesForAgent: typeof repairStaleOAuthProfilesForAgent;
    shouldRemoveLocalOAuthShadow: typeof shouldRemoveLocalOAuthShadow;
};
export { testing as __testing };
