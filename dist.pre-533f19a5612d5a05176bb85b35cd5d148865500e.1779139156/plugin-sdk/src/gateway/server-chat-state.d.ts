import type { AgentEventPayload } from "../infra/agent-events.js";
export type ChatRunEntry = {
    sessionKey: string;
    clientRunId: string;
};
export type BufferedAgentEvent = {
    sessionKey?: string;
    payload: AgentEventPayload & {
        spawnedBy?: string;
    };
};
export type ChatRunRegistry = {
    add: (sessionId: string, entry: ChatRunEntry) => void;
    peek: (sessionId: string) => ChatRunEntry | undefined;
    shift: (sessionId: string) => ChatRunEntry | undefined;
    remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
    clear: () => void;
};
export declare function createChatRunRegistry(): ChatRunRegistry;
export type ChatRunState = {
    registry: ChatRunRegistry;
    rawBuffers: Map<string, string>;
    buffers: Map<string, string>;
    deltaSentAt: Map<string, number>;
    /** Length of text at the time of the last broadcast, used to avoid duplicate flushes. */
    deltaLastBroadcastLen: Map<string, number>;
    deltaLastBroadcastText: Map<string, string>;
    agentDeltaSentAt: Map<string, number>;
    bufferedAgentEvents: Map<string, BufferedAgentEvent>;
    abortedRuns: Map<string, number>;
    clear: () => void;
};
export declare function createChatRunState(): ChatRunState;
export type ToolEventRecipientRegistry = {
    add: (runId: string, connId: string) => void;
    get: (runId: string) => ReadonlySet<string> | undefined;
    markFinal: (runId: string) => void;
};
export type SessionEventSubscriberRegistry = {
    subscribe: (connId: string) => void;
    unsubscribe: (connId: string) => void;
    getAll: () => ReadonlySet<string>;
    clear: () => void;
};
export type SessionMessageSubscriberRegistry = {
    subscribe: (connId: string, sessionKey: string) => void;
    unsubscribe: (connId: string, sessionKey: string) => void;
    unsubscribeAll: (connId: string) => void;
    get: (sessionKey: string) => ReadonlySet<string>;
    clear: () => void;
};
export declare function createSessionEventSubscriberRegistry(): SessionEventSubscriberRegistry;
export declare function createSessionMessageSubscriberRegistry(): SessionMessageSubscriberRegistry;
export declare function createToolEventRecipientRegistry(): ToolEventRecipientRegistry;
