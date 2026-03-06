import type { OpenClawConfig } from "../../config/config.js";
export type SessionHookContext = {
    sessionId: string;
    sessionKey: string;
    agentId: string;
};
export declare function buildSessionStartHookPayload(params: {
    sessionId: string;
    sessionKey: string;
    cfg: OpenClawConfig;
    resumedFrom?: string;
}): {
    event: {
        sessionId: string;
        sessionKey: string;
        resumedFrom?: string;
    };
    context: SessionHookContext;
};
export declare function buildSessionEndHookPayload(params: {
    sessionId: string;
    sessionKey: string;
    cfg: OpenClawConfig;
    messageCount?: number;
}): {
    event: {
        sessionId: string;
        sessionKey: string;
        messageCount: number;
    };
    context: SessionHookContext;
};
