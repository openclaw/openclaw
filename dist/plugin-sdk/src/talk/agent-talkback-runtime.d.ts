import type { RuntimeLogger } from "../plugins/runtime/types-core.js";
export type RealtimeVoiceAgentTalkbackResult = {
    text: string;
};
export type RealtimeVoiceAgentTalkbackQueue = {
    close(): void;
    enqueue(question: string, metadata?: unknown): void;
};
export type RealtimeVoiceAgentTalkbackQueueParams = {
    debounceMs: number;
    isStopped: () => boolean;
    logger: Pick<RuntimeLogger, "info" | "warn">;
    logPrefix: string;
    responseStyle: string;
    fallbackText: string;
    consult: (args: {
        question: string;
        metadata?: unknown;
        responseStyle: string;
        signal: AbortSignal;
    }) => Promise<RealtimeVoiceAgentTalkbackResult>;
    deliver: (text: string) => void;
};
export declare function createRealtimeVoiceAgentTalkbackQueue(params: RealtimeVoiceAgentTalkbackQueueParams): RealtimeVoiceAgentTalkbackQueue;
