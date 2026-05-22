import type { OpenClawConfig } from "../config/config.js";
import type { CommitmentExtractionBatchResult, CommitmentExtractionItem, CommitmentScope } from "./types.js";
type TimerHandle = ReturnType<typeof setTimeout>;
type ModelRef = {
    provider: string;
    model: string;
};
type CommitmentExtractionEnqueueInput = CommitmentScope & {
    cfg?: OpenClawConfig;
    nowMs?: number;
    userText: string;
    assistantText?: string;
    sourceMessageId?: string;
    sourceRunId?: string;
};
type CommitmentExtractionRuntime = {
    extractBatch?: (params: {
        cfg?: OpenClawConfig;
        items: CommitmentExtractionItem[];
    }) => Promise<CommitmentExtractionBatchResult>;
    resolveDefaultModel?: (params: {
        cfg: OpenClawConfig;
        agentId?: string;
    }) => ModelRef;
    setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
    clearTimer?: (timer: TimerHandle) => void;
    forceInTests?: boolean;
};
export declare function configureCommitmentExtractionRuntime(next: CommitmentExtractionRuntime): void;
export declare function resetCommitmentExtractionRuntimeForTests(): void;
export declare function enqueueCommitmentExtraction(input: CommitmentExtractionEnqueueInput): boolean;
export declare function drainCommitmentExtractionQueue(): Promise<number>;
export {};
