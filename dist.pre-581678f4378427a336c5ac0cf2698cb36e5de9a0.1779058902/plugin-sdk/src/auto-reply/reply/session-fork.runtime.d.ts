import { type SessionEntry as StoreSessionEntry } from "../../config/sessions/types.js";
export declare function resolveParentForkTokenCountRuntime(params: {
    parentEntry: StoreSessionEntry;
    storePath: string;
}): Promise<number | undefined>;
export declare function forkSessionFromParentRuntime(params: {
    parentEntry: StoreSessionEntry;
    agentId: string;
    sessionsDir: string;
}): Promise<{
    sessionId: string;
    sessionFile: string;
} | null>;
