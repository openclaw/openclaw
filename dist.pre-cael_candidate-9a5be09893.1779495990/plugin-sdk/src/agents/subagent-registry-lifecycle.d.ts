import type { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import type { callGateway as defaultCallGateway } from "../gateway/call.js";
import { type SubagentRunOutcome } from "./subagent-announce-output.js";
import { type SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
type CaptureSubagentCompletionReply = (typeof import("./subagent-announce.js"))["captureSubagentCompletionReply"];
type RunSubagentAnnounceFlow = (typeof import("./subagent-announce.js"))["runSubagentAnnounceFlow"];
export declare function createSubagentRegistryLifecycleController(params: {
    runs: Map<string, SubagentRunRecord>;
    resumedRuns: Set<string>;
    subagentAnnounceTimeoutMs: number;
    persist(): void;
    clearPendingLifecycleError(runId: string): void;
    countPendingDescendantRuns(rootSessionKey: string): number;
    suppressAnnounceForSteerRestart(entry?: SubagentRunRecord): boolean;
    shouldEmitEndedHookForRun(args: {
        entry: SubagentRunRecord;
        reason: SubagentLifecycleEndedReason;
    }): boolean;
    emitSubagentEndedHookForRun(args: {
        entry: SubagentRunRecord;
        reason?: SubagentLifecycleEndedReason;
        sendFarewell?: boolean;
        accountId?: string;
    }): Promise<void>;
    notifyContextEngineSubagentEnded(args: {
        childSessionKey: string;
        reason: "completed" | "deleted";
        agentDir?: string;
        workspaceDir?: string;
    }): Promise<void>;
    resumeSubagentRun(runId: string): void;
    callGateway: typeof defaultCallGateway;
    captureSubagentCompletionReply: CaptureSubagentCompletionReply;
    cleanupBrowserSessionsForLifecycleEnd?: typeof cleanupBrowserSessionsForLifecycleEnd;
    runSubagentAnnounceFlow: RunSubagentAnnounceFlow;
    warn(message: string, meta?: Record<string, unknown>): void;
}): {
    clearScheduledResumeTimers: () => void;
    completeCleanupBookkeeping: (cleanupParams: {
        runId: string;
        entry: SubagentRunRecord;
        cleanup: "delete" | "keep";
        completedAt: number;
    }) => void;
    completeSubagentRun: (completeParams: {
        runId: string;
        endedAt?: number;
        outcome: SubagentRunOutcome;
        reason: SubagentLifecycleEndedReason;
        sendFarewell?: boolean;
        accountId?: string;
        triggerCleanup: boolean;
    }) => Promise<void>;
    finalizeResumedAnnounceGiveUp: (giveUpParams: {
        runId: string;
        entry: SubagentRunRecord;
        reason: "retry-limit" | "expiry";
    }) => Promise<void>;
    refreshFrozenResultFromSession: (sessionKey: string) => Promise<boolean>;
    startSubagentAnnounceCleanupFlow: (runId: string, entry: SubagentRunRecord) => boolean;
};
export {};
