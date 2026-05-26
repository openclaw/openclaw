import type { SessionScope } from "../../config/sessions/types.js";
export declare function resolveCronAgentSessionKey(params: {
    sessionKey: string;
    agentId: string;
    mainKey?: string | undefined;
    cfg?: {
        session?: {
            scope?: SessionScope;
            mainKey?: string;
        };
    };
}): string;
