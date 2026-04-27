import type { AgentMessage } from "@mariozechner/pi-agent-core";
export declare function buildSessionsYieldContextMessage(message: string): string;
export declare function waitForSessionsYieldAbortSettle(params: {
    settlePromise: Promise<void> | null;
    runId: string;
    sessionId: string;
}): Promise<void>;
export declare function createYieldAbortedResponse(model: {
    api?: string;
    provider?: string;
    id?: string;
}): {
    [Symbol.asyncIterator]: () => AsyncGenerator<never, void, unknown>;
    result: () => Promise<{
        role: "assistant";
        content: Array<{
            type: "text";
            text: string;
        }>;
        stopReason: "aborted";
        api: string;
        provider: string;
        model: string;
        usage: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            totalTokens: number;
            cost: {
                input: number;
                output: number;
                cacheRead: number;
                cacheWrite: number;
                total: number;
            };
        };
        timestamp: number;
    }>;
};
export declare function queueSessionsYieldInterruptMessage(activeSession: {
    agent: {
        steer: (message: AgentMessage) => void;
    };
}): void;
export declare function persistSessionsYieldContextMessage(activeSession: {
    sendCustomMessage: (message: {
        customType: string;
        content: string;
        display: boolean;
        details?: Record<string, unknown>;
    }, options?: {
        triggerTurn?: boolean;
    }) => Promise<void>;
}, message: string): Promise<void>;
export declare function stripSessionsYieldArtifacts(activeSession: {
    messages: AgentMessage[];
    agent: {
        state: {
            messages: AgentMessage[];
        };
    };
    sessionManager?: unknown;
}): void;
