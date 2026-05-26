import type { OpenClawConfig } from "../config/types.openclaw.js";
export type SubagentSessionRole = "main" | "orchestrator" | "leaf";
type SubagentControlScope = "children" | "none";
type SessionCapabilityEntry = {
    sessionId?: unknown;
    spawnDepth?: unknown;
    subagentRole?: unknown;
    subagentControlScope?: unknown;
    spawnedBy?: unknown;
};
export type SessionCapabilityStore = Record<string, {
    sessionId?: unknown;
    spawnDepth?: unknown;
    subagentRole?: unknown;
    subagentControlScope?: unknown;
    spawnedBy?: unknown;
}>;
export declare function resolveSubagentCapabilityStore(sessionKey: string | undefined | null, opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
}): SessionCapabilityStore | undefined;
export declare function resolveSubagentCapabilities(params: {
    depth: number;
    maxSpawnDepth?: number;
}): {
    depth: number;
    role: SubagentSessionRole;
    controlScope: SubagentControlScope;
    canSpawn: boolean;
    canControlChildren: boolean;
};
export declare function isSubagentEnvelopeSession(sessionKey: string | undefined | null, opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
    entry?: SessionCapabilityEntry;
}): boolean;
export declare function resolveStoredSubagentCapabilities(sessionKey: string | undefined | null, opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
}): {
    depth: number;
    role: SubagentSessionRole;
    controlScope: SubagentControlScope;
    canSpawn: boolean;
    canControlChildren: boolean;
};
export {};
