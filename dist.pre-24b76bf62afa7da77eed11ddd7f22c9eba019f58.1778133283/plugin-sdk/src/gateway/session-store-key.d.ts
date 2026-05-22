import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function canonicalizeSessionKeyForAgent(agentId: string, key: string): string;
export declare function resolveSessionStoreKey(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    storeAgentId?: string;
}): string;
export declare function resolveSessionStoreAgentId(cfg: OpenClawConfig, canonicalKey: string): string;
export declare function resolveStoredSessionKeyForAgentStore(params: {
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
}): string;
export declare function resolveStoredSessionOwnerAgentId(params: {
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
}): string | null;
export declare function canonicalizeSpawnedByForAgent(cfg: OpenClawConfig, agentId: string, spawnedBy?: string): string | undefined;
