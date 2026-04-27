import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare const SUBAGENT_SESSION_ROLES: readonly ["main", "orchestrator", "leaf"];
export type SubagentSessionRole = (typeof SUBAGENT_SESSION_ROLES)[number];
export declare const SUBAGENT_CONTROL_SCOPES: readonly ["children", "none"];
export type SubagentControlScope = (typeof SUBAGENT_CONTROL_SCOPES)[number];
export type SessionCapabilityEntry = {
    sessionId?: unknown;
    spawnDepth?: unknown;
    subagentRole?: unknown;
    subagentControlScope?: unknown;
    spawnedBy?: unknown;
};
export type SessionCapabilityStore = Record<string, SessionCapabilityEntry>;
export declare function resolveSubagentCapabilityStore(sessionKey: string | undefined | null, opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
}): SessionCapabilityStore | undefined;
export declare function resolveSubagentRoleForDepth(params: {
    depth: number;
    maxSpawnDepth?: number;
}): SubagentSessionRole;
export declare function resolveSubagentControlScopeForRole(role: SubagentSessionRole): SubagentControlScope;
export declare function resolveSubagentCapabilities(params: {
    depth: number;
    maxSpawnDepth?: number;
}): {
    depth: number;
    role: "main" | "orchestrator" | "leaf";
    controlScope: "none" | "children";
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
    role: "main" | "orchestrator" | "leaf";
    controlScope: "none" | "children";
    canSpawn: boolean;
    canControlChildren: boolean;
};
