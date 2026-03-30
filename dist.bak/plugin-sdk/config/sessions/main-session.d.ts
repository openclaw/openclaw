import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { SessionScope } from "./types.js";
export declare function resolveMainSessionKey(cfg?: {
    session?: {
        scope?: SessionScope;
        mainKey?: string;
    };
    agents?: {
        list?: Array<{
            id?: string;
            default?: boolean;
        }>;
    };
}): string;
export declare function resolveMainSessionKeyFromConfig(): string;
export { resolveAgentIdFromSessionKey };
export declare function resolveAgentMainSessionKey(params: {
    cfg?: {
        session?: {
            mainKey?: string;
        };
    };
    agentId: string;
}): string;
export declare function resolveExplicitAgentSessionKey(params: {
    cfg?: {
        session?: {
            scope?: SessionScope;
            mainKey?: string;
        };
    };
    agentId?: string | null;
}): string | undefined;
export declare function canonicalizeMainSessionAlias(params: {
    cfg?: {
        session?: {
            scope?: SessionScope;
            mainKey?: string;
        };
    };
    agentId: string;
    sessionKey: string;
}): string;
