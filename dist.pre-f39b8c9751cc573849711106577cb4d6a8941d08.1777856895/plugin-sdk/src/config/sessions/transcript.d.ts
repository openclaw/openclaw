import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { SessionWriteLockAcquireTimeoutConfig } from "../../agents/session-write-lock.js";
import type { SessionEntry } from "./types.js";
export type SessionTranscriptAppendResult = {
    ok: true;
    sessionFile: string;
    messageId: string;
} | {
    ok: false;
    reason: string;
};
export type SessionTranscriptUpdateMode = "inline" | "file-only" | "none";
export type SessionTranscriptAssistantMessage = Parameters<SessionManager["appendMessage"]>[0] & {
    role: "assistant";
};
export type LatestAssistantTranscriptText = {
    id?: string;
    text: string;
    timestamp?: number;
};
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
export declare function readLatestAssistantTextFromSessionTranscript(sessionFile: string | undefined): Promise<LatestAssistantTranscriptText | undefined>;
export declare function appendAssistantMessageToSessionTranscript(params: {
    agentId?: string;
    sessionKey: string;
    text?: string;
    mediaUrls?: string[];
    idempotencyKey?: string;
    /** Optional override for store path (mostly for tests). */
    storePath?: string;
    updateMode?: SessionTranscriptUpdateMode;
    config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<SessionTranscriptAppendResult>;
export declare function appendExactAssistantMessageToSessionTranscript(params: {
    agentId?: string;
    sessionKey: string;
    message: SessionTranscriptAssistantMessage;
    idempotencyKey?: string;
    storePath?: string;
    updateMode?: SessionTranscriptUpdateMode;
    config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<SessionTranscriptAppendResult>;
