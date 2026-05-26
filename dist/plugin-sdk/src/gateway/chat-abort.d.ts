import type { BufferedAgentEvent } from "./server-chat-state.js";
export type ChatAbortControllerEntry = {
    controller: AbortController;
    sessionId: string;
    sessionKey: string;
    startedAtMs: number;
    expiresAtMs: number;
    ownerConnId?: string;
    ownerDeviceId?: string;
    providerId?: string;
    authProviderId?: string;
    abortStopReason?: string;
    /**
     * Which RPC owns this registration. Absent (undefined) is treated as
     * `"chat-send"` so pre-existing callers that constructed entries without
     * a kind keep their behavior. Consumers that need "chat.send specifically
     * is active" must check `kind !== "agent"`, not just `.has(runId)`.
     */
    kind?: "chat-send" | "agent";
};
type RegisteredChatAbortController = {
    controller: AbortController;
    registered: boolean;
    entry?: ChatAbortControllerEntry;
    cleanup: () => void;
};
export declare function isChatStopCommandText(text: string): boolean;
export declare function resolveAgentRunExpiresAtMs(params: {
    now: number;
    timeoutMs: number;
    graceMs?: number;
}): number;
export declare function registerChatAbortController(params: {
    chatAbortControllers: Map<string, ChatAbortControllerEntry>;
    runId: string;
    sessionId: string;
    sessionKey?: string | null;
    timeoutMs: number;
    ownerConnId?: string;
    ownerDeviceId?: string;
    providerId?: string;
    authProviderId?: string;
    kind?: ChatAbortControllerEntry["kind"];
    now?: number;
    expiresAtMs?: number;
}): RegisteredChatAbortController;
export type ChatAbortOps = {
    chatAbortControllers: Map<string, ChatAbortControllerEntry>;
    chatRunBuffers: Map<string, string>;
    chatDeltaSentAt: Map<string, number>;
    chatDeltaLastBroadcastLen: Map<string, number>;
    chatDeltaLastBroadcastText: Map<string, string>;
    agentDeltaSentAt: Map<string, number>;
    bufferedAgentEvents: Map<string, BufferedAgentEvent>;
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
export declare function updateChatRunProvider(chatAbortControllers: Map<string, ChatAbortControllerEntry>, params: {
    runId: string;
    providerId?: string;
    authProviderId?: string;
}): boolean;
export declare function abortChatRunsForProvider(ops: ChatAbortOps, params: {
    providerId: string;
    stopReason?: string;
}): {
    runIds: string[];
};
export {};
