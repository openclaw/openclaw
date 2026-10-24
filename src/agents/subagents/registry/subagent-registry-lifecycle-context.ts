import type { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { callGateway as defaultCallGateway } from "../../../gateway/call.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { createSubagentRegistryContextCleanup } from "./subagent-registry-context-cleanup.js";
import type { SubagentRunRecord, SubagentSessionEffects } from "./subagent-registry.types.js";

type CaptureSubagentCompletionReply =
  (typeof import("../announce/subagent-announce.js"))["captureSubagentCompletionReply"];
type RunSubagentAnnounceFlow =
  (typeof import("../announce/subagent-announce.js"))["runSubagentAnnounceFlow"];
type MaybeWakeRequesterAfterAllChildrenSettled =
  (typeof import("../announce/subagent-announce.requester-settle-wake.js"))["maybeWakeRequesterAfterAllChildrenSettled"];
type BrowserCleanup = typeof cleanupBrowserSessionsForLifecycleEnd;
type ContextCleanup = ReturnType<typeof createSubagentRegistryContextCleanup>;

export type SubagentLifecycleOptions = {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<object>;
  subagentAnnounceTimeoutMs: number;
  getRuntimeConfig(): OpenClawConfig;
  clearPendingLifecycleError(runId: string): void;
  countPendingDescendantRuns(rootSessionKey: string, assertCurrent: () => void): Promise<number>;
  getLatestRunForChildSession(
    childSessionKey: string,
    matches?: (entry: SubagentRunRecord) => boolean,
    childAgentId?: string,
  ): SubagentRunRecord | null;
  suppressAnnounceForSteerRestart(entry?: SubagentRunRecord): boolean;
  shouldEmitEndedHookForRun: ContextCleanup["shouldEmitEndedHookForRun"];
  emitSubagentEndedHookForRun: ContextCleanup["emitSubagentEndedHookForRun"];
  emitSubagentProgressEndedForRun(entry: SubagentRunRecord): Promise<void>;
  notifyContextEngineSubagentEnded: ContextCleanup["notifyContextEngineSubagentEnded"];
  retireSupersededRun(
    runId: string,
    entry: SubagentRunRecord,
    assertCurrent?: () => void,
  ): Promise<void>;
  resumeSubagentRun(runId: string): void;
  /** Confirms a provisional kill once its run's controller operation settles. */
  confirmProvisionalKill(entry: SubagentRunRecord): void;
  callGateway: typeof defaultCallGateway;
  captureSubagentCompletionReply: CaptureSubagentCompletionReply;
  cleanupBrowserSessionsForLifecycleEnd?: BrowserCleanup;
  loadCleanupBrowserSessionsForLifecycleEnd?: () => Promise<BrowserCleanup>;
  runSubagentAnnounceFlow: RunSubagentAnnounceFlow;
  maybeWakeRequesterAfterAllChildrenSettled: MaybeWakeRequesterAfterAllChildrenSettled;
  warn(message: string, meta?: Record<string, unknown>): void;
};

export interface SubagentLifecycleCommonContext {
  readonly options: SubagentLifecycleOptions;
  runBackgroundWork<T>(
    entry: SubagentRunRecord,
    run: (releasePreparation: () => void) => Promise<T>,
  ): Promise<T>;
  newerGenerationOwnsSession(entry: SubagentRunRecord): boolean;
  shouldSuppressSessionEffects(
    entry: SubagentRunRecord,
    prospectiveEffects?: SubagentSessionEffects,
  ): Promise<boolean>;
  sessionEffectsHostCurrent(entry: SubagentRunRecord): boolean;
  getSessionEffects(entry: SubagentRunRecord): SubagentSessionEffects | undefined;
}

export interface SubagentLifecycleCompletionContext extends SubagentLifecycleCommonContext {
  resumeAncestorCleanup(settledEntry: SubagentRunRecord): void;
  readonly progressEndedEntries: WeakSet<object>;
  acquireTerminalCompletionLock(runId: string): Promise<() => void>;
  bindTerminalSessionEffects(entry: SubagentRunRecord, effects?: SubagentSessionEffects): void;
  bumpCleanupGeneration(entry: SubagentRunRecord): number;
  isTerminalExecutionCurrent(entry: SubagentRunRecord): boolean;
  startSubagentAnnounceCleanupFlow(entry: SubagentRunRecord): boolean;
}

export interface SubagentLifecycleCleanupContext extends SubagentLifecycleCommonContext {
  readonly scheduledResumeTimers: Map<object, ReturnType<typeof setTimeout>>;
  readonly cleanupFailureCounts: WeakMap<object, number>;
  readonly cleanupReservations: Set<object>;
  readonly activeCleanupAttempts: Map<object, number>;
  pruneRetiredRuns(runIds?: readonly string[]): void;
  bumpCleanupGeneration(entry: SubagentRunRecord): number;
  incrementCleanupFailureCount(entry: SubagentRunRecord): number;
  isCleanupAttemptCurrent(entry: SubagentRunRecord, generation: number): boolean;
  isCleanupGeneration(entry: SubagentRunRecord, generation: number): boolean;
  isCleanupGenerationCurrent(entry: SubagentRunRecord, generation: number): boolean;
  isCleanupOwnerCurrent(entry: SubagentRunRecord): boolean;
  startSubagentAnnounceCleanupFlow(entry: SubagentRunRecord): boolean;
}

export interface SubagentLifecycleAnnounceCleanupContext
  extends SubagentLifecycleCleanupContext, SubagentLifecycleWakeContext {
  completeCleanupBookkeeping(args: CleanupBookkeepingParams): Promise<void>;
}

/** One in-flight requester wake evaluation and the trigger that must rerun it. */
export type RequesterSettleWakeEvaluation = {
  entry: SubagentRunRecord;
  /** The row the evaluation read; absent until it starts reading registry state. */
  evaluated?: SubagentRunRecord;
  rearm?: SubagentRunRecord;
};

export type RequesterSettleWakeWait = {
  entry: SubagentRunRecord;
  deadline?: number;
  timer?: ReturnType<typeof setTimeout>;
};

export interface SubagentLifecycleWakeContext extends SubagentLifecycleCommonContext {
  /** In-flight requester wake evaluations; a trigger during one requests a rerun. */
  readonly activeRequesterSettleWakes: Map<string, RequesterSettleWakeEvaluation>;
  readonly waitingRequesterSettleWakes: Map<string, RequesterSettleWakeWait>;
  resumeAncestorCleanup(settledEntry: SubagentRunRecord): void;
  runRequesterSettleWake(
    entry: SubagentRunRecord,
    run: (releasePreparation: () => void) => Promise<unknown>,
    isCurrent: () => boolean,
  ): Promise<unknown>;
}

export type CleanupBookkeepingParams = {
  stateContext?: OpenClawStateWorkerContext;
  runId: string;
  entry: SubagentRunRecord;
  cleanup: "delete" | "keep";
  completedAt: number;
  preserveTranscript?: boolean;
  provisionalKill?: boolean;
  skipRequesterSettleWake?: boolean;
  isCurrent?: () => boolean;
  finalizeDelivery?: (draft: SubagentRunRecord) => void;
};
