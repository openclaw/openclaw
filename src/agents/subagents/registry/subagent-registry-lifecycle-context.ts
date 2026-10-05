import type { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { callGateway as defaultCallGateway } from "../../../gateway/call.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
// This type-only leaf exists solely to keep lifecycle sibling modules from importing the controller.
// Keeping the controller out of their dependency graph satisfies the architecture cycle gate.
import type { RequesterWakeCommittedWrite } from "../completion/subagent-completion-mutation.types.js";
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
  retireSupersededRun(runId: string, entry: SubagentRunRecord): Promise<void>;
  resumeSubagentRun(runId: string): void;
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
  newerGenerationOwnsSession(entry: SubagentRunRecord): boolean;
  shouldSuppressSessionEffects(
    entry: SubagentRunRecord,
    prospectiveEffects?: SubagentSessionEffects,
  ): Promise<boolean>;
  sessionEffectsHostCurrent(entry: SubagentRunRecord): boolean;
  getSessionEffects(entry: SubagentRunRecord): SubagentSessionEffects | undefined;
}

export interface SubagentLifecycleCompletionContext extends SubagentLifecycleCommonContext {
  readonly progressEndedEntries: WeakSet<object>;
  acquireTerminalCompletionLock(runId: string): Promise<() => void>;
  bindTerminalSessionEffects(entry: SubagentRunRecord, effects?: SubagentSessionEffects): void;
  bumpCleanupGeneration(entry: SubagentRunRecord): number;
  bumpTerminalGeneration(entry: SubagentRunRecord, bindingChanged?: boolean): number;
  isTerminalCallbackCurrent(entry: SubagentRunRecord, generation: number): boolean;
  startSubagentAnnounceCleanupFlow(entry: SubagentRunRecord): boolean;
}

export interface SubagentLifecycleCleanupContext extends SubagentLifecycleCommonContext {
  readonly scheduledResumeTimers: Set<ReturnType<typeof setTimeout>>;
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

export type PendingRequesterSettleWakeCommit = {
  entries: readonly SubagentRunRecord[];
  isCurrent(entry: SubagentRunRecord): boolean;
  commit(
    entries: readonly SubagentRunRecord[],
    pending: PendingRequesterSettleWakeCommit,
  ): boolean | Promise<boolean>;
  generation: number | undefined;
  committedWake?: RequesterWakeCommittedWrite;
  /** One current retry caller must resume the published transition. */
  needsWakeContinuation?: boolean;
  initialTransfer?: {
    kind: "intent" | "yielded-cohort" | "completed-cohort";
    completion: Promise<void>;
    published: boolean;
    completed: boolean;
    blocked: boolean;
    retire(): void;
  };
  stateContext?: OpenClawStateWorkerContext;
  ownsRetirement(entry: SubagentRunRecord): boolean;
  adoptPublished(entries: readonly SubagentRunRecord[]): readonly SubagentRunRecord[];
  retryWholeBatch: boolean;
  inFlight?: Promise<void>;
  failures: number;
  nextAttemptAt: number;
  /** One sustained-failure report was emitted for this retry episode. */
  sustainedFailureReported?: boolean;
  /** Fault last reported for this episode; a different one is not a repeat. */
  reportedFailureSignature?: string;
  /** Reports already emitted for the current signature. */
  reportedFailureLogs?: number;
  /** Identical failure reports withheld after the reporting budget ran out. */
  suppressedFailureLogs?: number;
};

export interface SubagentLifecycleWakeContext extends SubagentLifecycleCommonContext {
  readonly scheduledRequesterSettleWakeTimers: Map<string, ScheduledRequesterSettleWake>;
  readonly scheduledRequesterSettleWakeRuns: Set<object>;
  readonly pendingRequesterSettleWakeRearms: Set<object>;
  readonly cancelledRequesterSettleWakeRuns: Set<object>;
  readonly pendingRequesterSettleWakeCommits: Map<object, PendingRequesterSettleWakeCommit>;
  resumeAncestorCleanup(settledEntry: SubagentRunRecord): void;
  runRequesterSettleWake(
    entry: SubagentRunRecord,
    run: () => Promise<unknown>,
    isCurrent: () => boolean,
  ): Promise<unknown>;
  unmarkRequesterSettleWakeRunScheduled(entry: SubagentRunRecord): void;
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
  discardDelivery?: (draft: SubagentRunRecord) => void;
};

export type ScheduledRequesterSettleWake = {
  entry: SubagentRunRecord;
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
  rearmGeneration?: number;
  stateContext: OpenClawStateWorkerContext;
};
