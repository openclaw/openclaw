export type ChatAbortControllerEntry = {
    controller: AbortController;
    sessionId: string;
    sessionKey: string;
    startedAtMs: number;
    expiresAtMs: number;
};
export declare function isChatStopCommandText(text: string): boolean;
export declare function resolveChatRunExpiresAtMs(params: {
    now: number;
    timeoutMs: number;
    graceMs?: number;
    minMs?: number;
    maxMs?: number;
}): number;
export type ChatAbortOps = {
    chatAbortControllers: Map<string, ChatAbortControllerEntry>;
    chatRunBuffers: Map<string, string>;
    chatDeltaSentAt: Map<string, number>;
    chatAbortedRuns: Map<string, number>;
    removeChatRun: (sessionId: string, clientRunId: string, sessionKey?: string) => {
        sessionKey: string;
        clientRunId: string;
    } | undefined;
    agentRunSeq: Map<string, number>;
    broadcast: (event: string, payload: unknown, opts?: {
        dropIfSlow?: boolean;
    }) => void;
    nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
};
export declare function abortChatRunById(ops: ChatAbortOps, params: {
    runId: string;
    sessionKey: string;
    stopReason?: string;
}): {
    aborted: boolean;
};
export declare function abortChatRunsForSessionKey(ops: ChatAbortOps, params: {
    sessionKey: string;
    stopReason?: string;
}): {
    aborted: boolean;
    runIds: string[];
};
