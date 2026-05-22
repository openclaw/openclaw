import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type AuthProfileStore } from "./auth-profiles.js";
export declare function hasAuthForModelProvider(params: {
    provider: string;
    cfg?: OpenClawConfig;
    workspaceDir?: string;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
    store?: AuthProfileStore;
}): boolean;
export declare function createProviderAuthChecker(params: {
    cfg?: OpenClawConfig;
    workspaceDir?: string;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
}): (provider: string) => boolean;
