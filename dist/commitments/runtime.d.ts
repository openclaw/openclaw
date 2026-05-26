import { i as OpenClawConfig } from "../types.openclaw-BLF4DJTX.js";
import { a as CommitmentScope, n as CommitmentExtractionBatchResult, r as CommitmentExtractionItem } from "../types-B3lUN4pX.js";

//#region src/commitments/runtime.d.ts
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
declare function configureCommitmentExtractionRuntime(next: CommitmentExtractionRuntime): void;
declare function resetCommitmentExtractionRuntimeForTests(): void;
declare function enqueueCommitmentExtraction(input: CommitmentExtractionEnqueueInput): boolean;
declare function drainCommitmentExtractionQueue(): Promise<number>;
//#endregion
export { configureCommitmentExtractionRuntime, drainCommitmentExtractionQueue, enqueueCommitmentExtraction, resetCommitmentExtractionRuntimeForTests };