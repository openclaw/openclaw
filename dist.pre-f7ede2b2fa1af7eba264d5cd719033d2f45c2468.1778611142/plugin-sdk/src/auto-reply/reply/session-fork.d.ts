import type { SessionEntry } from "../../config/sessions/types.js";
export type ParentForkDecision = {
    status: "fork";
    maxTokens: number;
    parentTokens?: number;
} | {
    status: "skip";
    reason: "parent-too-large";
    maxTokens: number;
    parentTokens: number;
    message: string;
};
export declare function resolveParentForkDecision(params: {
    parentEntry: SessionEntry;
    storePath: string;
}): Promise<ParentForkDecision>;
export declare function forkSessionFromParent(params: {
    parentEntry: SessionEntry;
    agentId: string;
    sessionsDir: string;
}): Promise<{
    sessionId: string;
    sessionFile: string;
} | null>;
