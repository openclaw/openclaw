import type { SessionWriteLockAcquireTimeoutConfig } from "../../agents/session-write-lock.js";
export type GatewayInjectedAbortMeta = {
    aborted: true;
    origin: "rpc" | "stop-command";
    runId: string;
};
export type GatewayInjectedTranscriptAppendResult = {
    ok: boolean;
    messageId?: string;
    message?: Record<string, unknown>;
    error?: string;
};
export declare function appendInjectedAssistantMessageToTranscript(params: {
    transcriptPath: string;
    message: string;
    label?: string;
    /** When set, used as the assistant `content` array (e.g. text + embedded audio blocks). */
    content?: Array<Record<string, unknown>>;
    idempotencyKey?: string;
    abortMeta?: GatewayInjectedAbortMeta;
    now?: number;
    config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<GatewayInjectedTranscriptAppendResult>;
