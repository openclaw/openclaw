import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type AuthProfileStore } from "./auth-profiles.js";
import { type RuntimeProviderAuthLookup } from "./model-auth.js";
export declare function clearCurrentProviderAuthState(): void;
export declare function hasAuthForModelProvider(params: {
    provider: string;
    cfg?: OpenClawConfig;
    workspaceDir?: string;
    agentId?: string;
    env?: NodeJS.ProcessEnv;
    store?: AuthProfileStore;
    allowPluginSyntheticAuth?: boolean;
    discoverExternalCliAuth?: boolean;
    runtimeAuthLookup?: RuntimeProviderAuthLookup;
    resolveRuntimeAuthLookup?: () => RuntimeProviderAuthLookup;
}): Promise<boolean>;
export declare function createProviderAuthChecker(params: {
    cfg?: OpenClawConfig;
    workspaceDir?: string;
    agentId?: string;
    env?: NodeJS.ProcessEnv;
    allowPluginSyntheticAuth?: boolean;
    discoverExternalCliAuth?: boolean;
}): (provider: string) => Promise<boolean>;
export declare function warmCurrentProviderAuthState(cfg: OpenClawConfig, options?: {
    isCancelled?: () => boolean;
}): Promise<void>;
