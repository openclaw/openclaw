import { type SessionEntry as StoredSessionEntry } from "../config/sessions.js";
export declare function resolveBtwSessionTranscriptPath(params: {
    sessionId: string;
    sessionEntry?: StoredSessionEntry;
    sessionKey?: string;
    storePath?: string;
}): string | undefined;
export declare function readBtwTranscriptMessages(params: {
    sessionFile: string;
    sessionId: string;
    snapshotLeafId?: string | null;
}): Promise<unknown[]>;
