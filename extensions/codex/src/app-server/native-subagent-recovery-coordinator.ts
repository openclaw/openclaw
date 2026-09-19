import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  ChildState,
  NativeTurnEnd,
  NativeTurnObservation,
  ParentState,
  TaskRecoveryCandidate,
  ThreadStatusRevision,
} from "./native-subagent-monitor-types.js";
import type { CodexNativeSubagentCompletion } from "./native-subagent-notification.js";
import { delayForAttempt } from "./native-subagent-retry.js";

type NativeSubagentRecoveryDependencies = {
  isDisposed: () => boolean;
  isRegisteredChild: (child: ChildState) => boolean;
  currentChild: (threadId: string) => ChildState | undefined;
  parentState: (parentThreadId: string) => ParentState | undefined;
  isRetiredParent: (state: ParentState) => boolean;
  reconcileChildState: (child: ChildState) => Promise<boolean>;
  reconcileTaskCandidateOnce: (candidate: TaskRecoveryCandidate) => Promise<void>;
  processCompletion: (
    state: ParentState,
    child: ChildState,
    completion: CodexNativeSubagentCompletion,
    eventAt: number,
  ) => Promise<void>;
  onCandidateSettled: (parentState: ParentState) => void;
  now: () => number;
  recoveryPollDelaysMs?: readonly number[];
};

export const DEFAULT_RECOVERY_POLL_DELAYS_MS = [
  2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];

export class CodexNativeSubagentRecoveryCoordinator {
  private readonly taskReconciliations = new Map<
    string,
    { candidate: TaskRecoveryCandidate; promise: Promise<void> }
  >();
  private readonly taskReconciliationTimers = new Map<
    string,
    { candidate: TaskRecoveryCandidate; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly threadStatusRevisions = new Map<string, ThreadStatusRevision>();
  private readonly recoveryPollDelaysMs: readonly number[];

  constructor(private readonly dependencies: NativeSubagentRecoveryDependencies) {
    this.recoveryPollDelaysMs =
      dependencies.recoveryPollDelaysMs ?? DEFAULT_RECOVERY_POLL_DELAYS_MS;
  }

  allCandidates(): TaskRecoveryCandidate[] {
    return [...this.taskReconciliations.values(), ...this.taskReconciliationTimers.values()].map(
      ({ candidate }) => candidate,
    );
  }

  observeUnregisteredTurn(
    threadId: string,
    turnId: string,
    started: boolean,
    end: NativeTurnEnd | undefined,
  ): TaskRecoveryCandidate[] {
    const candidates = [...new Set(this.allCandidates())].filter(
      (candidate) =>
        candidate.childThreadId === threadId &&
        !this.dependencies.isRetiredParent(candidate.parentState),
    );
    for (const turns of new Set(candidates.map((candidate) => candidate.observedTurns))) {
      const observed = turns.find((entry) => entry.turnId === turnId);
      if (!started) {
        if (observed) {
          observed.state = end;
        } else {
          turns.push({ turnId, state: end });
        }
      } else if (!observed) {
        const previous = turns.at(-1);
        if (previous?.state === "active") {
          previous.state = undefined;
        }
        turns.push({ turnId, state: "active", startObserved: true });
      }
    }
    return candidates;
  }

  hasRevision(threadId: string): boolean {
    return this.threadStatusRevisions.has(threadId);
  }

  observeRevision(threadId: string): void {
    const revision = this.threadStatusRevisions.get(threadId);
    if (revision) {
      revision.value += 1;
    }
  }

  isTerminalRevision(threadId: string): boolean {
    return this.threadStatusRevisions.get(threadId)?.terminal === true;
  }

  markTerminalRevision(threadId: string): void {
    const revision = this.threadStatusRevisions.get(threadId);
    if (revision) {
      revision.terminal = true;
    }
  }

  seedRevision(threadId: string, parentThreadId: string): void {
    this.threadStatusRevisions.set(
      threadId,
      this.threadStatusRevisions.get(threadId) ?? { value: 0, readers: 0, parentThreadId },
    );
  }

  dispose(): void {
    for (const { timer } of this.taskReconciliationTimers.values()) {
      clearTimeout(timer);
    }
    this.taskReconciliationTimers.clear();
  }

  async reconcileRegisteredChild(childState: ChildState): Promise<boolean> {
    if (
      childState.terminal ||
      this.dependencies.isDisposed() ||
      !this.dependencies.isRegisteredChild(childState)
    ) {
      return false;
    }
    if (childState.recoveryInFlight) {
      return await childState.recoveryInFlight;
    }
    const recovery = this.dependencies.reconcileChildState(childState);
    childState.recoveryInFlight = recovery;
    try {
      return await recovery;
    } finally {
      if (childState.recoveryInFlight === recovery) {
        childState.recoveryInFlight = undefined;
      }
    }
  }

  pendingChildRecoveries(state: ParentState, threadId: string): TaskRecoveryCandidate[] {
    return [...new Set(this.allCandidates())].filter(
      (candidate) =>
        candidate.childThreadId === threadId &&
        candidate.requesterSessionKey === state.requesterSessionKey &&
        candidate.parentState.parentThreadId === state.parentThreadId &&
        !this.dependencies.isRetiredParent(candidate.parentState),
    );
  }

  resolveChildTurnBuffer(state: ParentState, threadId: string): NativeTurnObservation[] {
    return this.pendingChildRecoveries(state, threadId)[0]?.observedTurns ?? [];
  }

  clearTerminalRevisionsForParent(parentThreadId: string): void {
    for (const [threadId, revision] of this.threadStatusRevisions) {
      if (revision.parentThreadId === parentThreadId) {
        this.collectThreadStatusRevision(threadId, revision);
      }
    }
  }

  collectThreadStatusRevision(
    threadId: string,
    revision = this.threadStatusRevisions.get(threadId),
  ) {
    if (!revision || revision.readers > 0 || Boolean(this.dependencies.currentChild(threadId))) {
      return;
    }
    const parent = revision.parentThreadId
      ? this.dependencies.parentState(revision.parentThreadId)
      : undefined;
    if (parent?.owners.size) {
      return;
    }
    if (this.threadStatusRevisions.get(threadId) === revision) {
      this.threadStatusRevisions.delete(threadId);
    }
  }

  scheduleRecoveryPoll(childState: ChildState): void {
    if (
      childState.terminal ||
      childState.settledWithoutCompletion ||
      childState.recoveryTimer ||
      this.dependencies.isDisposed() ||
      this.recoveryPollDelaysMs.length === 0
    ) {
      return;
    }
    const delayMs = delayForAttempt(this.recoveryPollDelaysMs, childState.recoveryAttempt++);
    childState.recoveryTimer = setTimeout(() => {
      childState.recoveryTimer = undefined;
      void this.reconcileRegisteredChild(childState)
        .catch((error: unknown) => {
          logRecoveryFailure(childState.childThreadId, error);
          return false;
        })
        .then(async (reconciled) => {
          if (reconciled || !this.dependencies.isRegisteredChild(childState)) {
            return;
          }
          const fallback = childState.fallbackCompletion;
          const state = this.dependencies.parentState(childState.parentThreadId);
          // Give thread/read two persistence windows before delivering the
          // typed no-final result; otherwise a just-written final can be lost.
          if (fallback && state && childState.recoveryAttempt >= 2) {
            await this.dependencies.processCompletion(
              state,
              childState,
              fallback,
              fallback.completedAt ?? this.dependencies.now(),
            );
            return;
          }
          this.scheduleRecoveryPoll(childState);
        });
    }, delayMs);
    childState.recoveryTimer.unref();
  }

  setRecoveryFallback(
    childState: ChildState,
    completion: CodexNativeSubagentCompletion,
    eventAt: number,
  ): void {
    if (childState.terminal) {
      return;
    }
    const current = childState.fallbackCompletion;
    if (
      current?.status === completion.status &&
      current.statusLabel === completion.statusLabel &&
      current.result === completion.result
    ) {
      return;
    }
    if (childState.recoveryTimer) {
      clearTimeout(childState.recoveryTimer);
      childState.recoveryTimer = undefined;
    }
    childState.recoveryAttempt = 0;
    childState.fallbackCompletion = { ...completion, completedAt: eventAt };
    this.scheduleRecoveryPoll(childState);
  }

  clearSystemErrorFallback(childState: ChildState): void {
    if (childState.fallbackCompletion?.statusLabel !== "system_error") {
      return;
    }
    childState.fallbackCompletion = undefined;
  }

  retainThreadStatusRevision(threadId: string): {
    isCurrent: () => boolean;
    release: () => void;
  } {
    const revision = this.threadStatusRevisions.get(threadId) ?? { value: 0, readers: 0 };
    this.threadStatusRevisions.set(threadId, revision);
    revision.readers += 1;
    const capturedValue = revision.value;
    let retained = true;
    return {
      isCurrent: () =>
        this.threadStatusRevisions.get(threadId) === revision && revision.value === capturedValue,
      release: () => {
        if (!retained) {
          return;
        }
        retained = false;
        revision.readers -= 1;
        this.collectThreadStatusRevision(threadId, revision);
      },
    };
  }

  clearRecoveryTimers(childState: ChildState): void {
    if (childState.recoveryTimer) {
      clearTimeout(childState.recoveryTimer);
      childState.recoveryTimer = undefined;
    }
  }

  async reconcileTaskCandidate(
    candidate: TaskRecoveryCandidate,
    after?: Promise<void>,
  ): Promise<void> {
    const key = `${candidate.requesterSessionKey}\0${candidate.runId}`;
    const scheduled = this.taskReconciliationTimers.get(key);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.taskReconciliationTimers.delete(key);
    }
    const existing = this.taskReconciliations.get(key);
    if (existing) {
      await existing.promise;
      return;
    }
    // Hold single-flight through delivery. Releasing after the read lets a slower
    // reconcile recreate a just-pruned child and deliver the same result twice.
    const reconciliation = after
      ? after.then(() => this.dependencies.reconcileTaskCandidateOnce(candidate))
      : this.dependencies.reconcileTaskCandidateOnce(candidate);
    this.taskReconciliations.set(key, { candidate, promise: reconciliation });
    try {
      await reconciliation;
    } finally {
      if (this.taskReconciliations.get(key)?.promise === reconciliation) {
        this.taskReconciliations.delete(key);
      }
      this.dependencies.onCandidateSettled(candidate.parentState);
    }
  }

  scheduleTaskCandidateReconciliation(candidate: TaskRecoveryCandidate): void {
    const key = `${candidate.requesterSessionKey}\0${candidate.runId}`;
    if (
      this.dependencies.isDisposed() ||
      this.dependencies.isRetiredParent(candidate.parentState) ||
      this.recoveryPollDelaysMs.length === 0 ||
      this.taskReconciliationTimers.has(key)
    ) {
      return;
    }
    const delayMs = delayForAttempt(this.recoveryPollDelaysMs, candidate.recoveryAttempt++);
    const timer = setTimeout(() => {
      this.taskReconciliationTimers.delete(key);
      void this.reconcileTaskCandidate(candidate).catch((error: unknown) => {
        logRecoveryFailure(candidate.childThreadId, error);
        this.scheduleTaskCandidateReconciliation(candidate);
      });
    }, delayMs);
    this.taskReconciliationTimers.set(key, { candidate, timer });
    timer.unref();
  }
}

export function logRecoveryFailure(childThreadId: string, error: unknown): void {
  embeddedAgentLog.debug("Codex native subagent history is not ready", {
    childThreadId,
    error: formatErrorMessage(error),
  });
}
