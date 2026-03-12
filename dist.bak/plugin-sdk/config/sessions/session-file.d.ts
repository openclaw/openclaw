import type { SessionEntry } from "./types.js";
export declare function resolveAndPersistSessionFile(params: {
    sessionId: string;
    sessionKey: string;
    sessionStore: Record<string, SessionEntry>;
    storePath: string;
    sessionEntry?: SessionEntry;
    agentId?: string;
    sessionsDir?: string;
    fallbackSessionFile?: string;
    activeSessionKey?: string;
}): Promise<{
    sessionFile: string;
    sessionEntry: SessionEntry;
}>;
