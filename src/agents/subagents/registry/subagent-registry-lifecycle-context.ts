import type { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { callGateway as defaultCallGateway } from "../../../gateway/call.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
// This type-only leaf exists solely to keep lifecycle sibling modules from importing the controller.
// Keeping the controller out of their dependency graph satisfies the architecture cycle gate.
import type { RequesterWakeCommittedWrite } from "../completion/subagent-completion-mutation.types.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SubagentRegistryWriteOptions } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord, SubagentSessionEffects } from "./subagent-registry.types.js";

type CaptureSubagentCompletionReply =
  (typeof import("../announce/subagent-announce.js"))["captureSubagentCompletionReply"];
type RunSubagentAnnounceFlow =
  (typeof import("../announce/subagent-announce.js"))["runSubagentAnnounceFlow"];
type MaybeWakeRequesterAfterAllChildrenSettled =
  (typeof import("../announce/subagent-announce.requester-settle-wake.js"))["maybeWakeRequesterAfterAllChildrenSettled"];
type BrowserCleanup = typeof cleanupBrowserSessionsForLifecycleEnd;

export type SubagentLifecycleOptions = {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  subagentAnnounceTimeoutMs: number;
  getRuntimeConfig(): OpenClawConfig;
  persist(...runIds: string[]): void;
  persistOrThrow(...runIds: string[]): void;
  persistAsyncOrThrow: (
    context: OpenClawStateWorkerContext,
    callbacks: Omit<SubagentRegistryWriteOptions, "context"> & { assertCurrent: () => void },
    ...runIds: string[]
  ) => Promise<void>;
  clearPendingLifecycleError(runId: string): void;
  countPendingDescendantRuns(rootSessionKey: string): number;
  getLatestRunForChildSession(
    childSessionKey: string,
    matches?: (entry: SubagentRunRecord) => boolean,
  ): SubagentRunRecord | null;
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
    isCurrent?: () => boolean;
    prepareCurrent?: () => Promise<boolean>;
  }): Promise<void>;
  emitSubagentProgressEndedForRun(entry: SubagentRunRecord): Promise<void>;
  notifyContextEngineSubagentEnded(
    args: {
      childSessionKey: string;
      reason: "completed" | "deleted";
      agentDir?: string;
      workspaceDir?: string;
    },
    options?: { isCurrent?: () => boolean; prepareCurrent?: () => Promise<boolean> },
  ): Promise<void>;
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
  readonly progressEndedEntries: WeakSet<SubagentRunRecord>;
  acquireTerminalCompletionLock(runId: string): Promise<() => void>;
  bindTerminalSessionEffects(entry: SubagentRunRecord, effects?: SubagentSessionEffects): void;
  bumpCleanupGeneration(entry: SubagentRunRecord): number;
  bumpTerminalGeneration(entry: SubagentRunRecord): number;
  isTerminalCallbackCurrent(runId: string, entry: SubagentRunRecord, generation: number): boolean;
  startSubagentAnnounceCleanupFlow(runId: string, entry: SubagentRunRecord): boolean;
}

export interface SubagentLifecycleCleanupContext extends SubagentLifecycleCommonContext {
  readonly scheduledResumeTimers: Set<ReturnType<typeof setTimeout>>;
  readonly cleanupFailureCounts: WeakMap<SubagentRunRecord, number>;
  bumpCleanupGeneration(entry: SubagentRunRecord): number;
  incrementCleanupFailureCount(entry: SubagentRunRecord): number;
  isCleanupAttemptCurrent(runId: string, entry: SubagentRunRecord, generation: number): boolean;
  isCleanupGeneration(entry: SubagentRunRecord, generation: number): boolean;
  isCleanupGenerationCurrent(runId: string, entry: SubagentRunRecord, generation: number): boolean;
  isEndedHookOwnerCurrent(runId: string, entry: SubagentRunRecord): boolean;
  startSubagentAnnounceCleanupFlow(runId: string, entry: SubagentRunRecord): boolean;
}

export interface SubagentLifecycleAnnounceCleanupContext
  extends SubagentLifecycleCleanupContext, SubagentLifecycleWakeContext {
  completeCleanupBookkeeping(args: CleanupBookkeepingParams): void;
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
  isPublishedRetirement(entry: SubagentRunRecord): boolean;
  adoptPublished(entries: readonly SubagentRunRecord[]): void;
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
  readonly scheduledRequesterSettleWakeRuns: WeakSet<SubagentRunRecord>;
  readonly pendingRequesterSettleWakeRearms: WeakSet<SubagentRunRecord>;
  readonly pendingRequesterSettleWakeCommits: WeakMap<
    SubagentRunRecord,
    PendingRequesterSettleWakeCommit
  >;
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
};

export type ScheduledRequesterSettleWake = {
  entry: SubagentRunRecord;
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
  rearmGeneration?: number;
  stateContext: OpenClawStateWorkerContext;
};
