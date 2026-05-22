import type { OpenClawConfig } from "../types.openclaw.js";
export type SessionStoreSelectionOptions = {
    store?: string;
    agent?: string;
    allAgents?: boolean;
};
export type SessionStoreTarget = {
    agentId: string;
    storePath: string;
};
export declare function resolveAllAgentSessionStoreTargetsSync(cfg: OpenClawConfig, params?: {
    env?: NodeJS.ProcessEnv;
}): SessionStoreTarget[];
export declare function resolveAgentSessionStoreTargetsSync(cfg: OpenClawConfig, agentId: string, params?: {
    env?: NodeJS.ProcessEnv;
}): SessionStoreTarget[];
export declare function resolveAllAgentSessionStoreTargets(cfg: OpenClawConfig, params?: {
    env?: NodeJS.ProcessEnv;
}): Promise<SessionStoreTarget[]>;
export declare function resolveSessionStoreTargets(cfg: OpenClawConfig, opts: SessionStoreSelectionOptions, params?: {
    env?: NodeJS.ProcessEnv;
}): SessionStoreTarget[];
