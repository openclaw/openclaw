import type { SessionEntry } from "./types.js";
export declare function resolveMirroredTranscriptText(params: {
    text?: string;
    mediaUrls?: string[];
}): string | null;
export declare function resolveSessionTranscriptFile(params: {
    sessionId: string;
    sessionKey: string;
    sessionEntry: SessionEntry | undefined;
    sessionStore?: Record<string, SessionEntry>;
    storePath?: string;
    agentId: string;
    threadId?: string | number;
}): Promise<{
    sessionFile: string;
    sessionEntry: SessionEntry | undefined;
}>;
export declare function appendAssistantMessageToSessionTranscript(params: {
    agentId?: string;
    sessionKey: string;
    text?: string;
    mediaUrls?: string[];
    idempotencyKey?: string;
    /** Optional override for store path (mostly for tests). */
    storePath?: string;
}): Promise<{
    ok: true;
    sessionFile: string;
} | {
    ok: false;
    reason: string;
}>;
