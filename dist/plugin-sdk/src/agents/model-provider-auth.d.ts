import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type AuthProfileStore } from "./auth-profiles.js";
export declare function hasAuthForModelProvider(params: {
    provider: string;
    cfg?: OpenClawConfig;
    workspaceDir?: string;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
    store?: AuthProfileStore;
    allowPluginSyntheticAuth?: boolean;
    discoverExternalCliAuth?: boolean;
}): boolean;
export declare function createProviderAuthChecker(params: {
    cfg?: OpenClawConfig;
    workspaceDir?: string;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
    allowPluginSyntheticAuth?: boolean;
    discoverExternalCliAuth?: boolean;
}): (provider: string) => boolean;
