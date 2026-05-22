import { type SessionWriteLockAcquireTimeoutConfig } from "../../agents/session-write-lock.js";
export declare function appendSessionTranscriptMessage(params: {
    transcriptPath: string;
    message: unknown;
    now?: number;
    sessionId?: string;
    cwd?: string;
    useRawWhenLinear?: boolean;
    config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<{
    messageId: string;
}>;
