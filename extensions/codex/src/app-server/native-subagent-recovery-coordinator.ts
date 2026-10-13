import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ChildState, ParentState } from "./native-subagent-monitor-types.js";
import type { CodexNativeSubagentCompletion } from "./native-subagent-notification.js";
import { delayForAttempt } from "./native-subagent-retry.js";

type NativeSubagentRecoveryDependencies = {
  isDisposed: () => boolean;
  isRegisteredChild: (child: ChildState) => boolean;
  parentState: (parentThreadId: string) => ParentState | undefined;
  reconcileChildState: (child: ChildState) => Promise<boolean>;
  processCompletion: (
    state: ParentState,
    child: ChildState,
    completion: CodexNativeSubagentCompletion,
    eventAt: number,
  ) => Promise<void>;
  recoveryPollDelaysMs?: readonly number[];
};

export const DEFAULT_RECOVERY_POLL_DELAYS_MS = [
  2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];

export class CodexNativeSubagentRecoveryCoordinator {
  private readonly terminalThreads = new Map<string, string>();
  private readonly recoveryPollDelaysMs: readonly number[];

  constructor(private readonly dependencies: NativeSubagentRecoveryDependencies) {
    this.recoveryPollDelaysMs =
      dependencies.recoveryPollDelaysMs ?? DEFAULT_RECOVERY_POLL_DELAYS_MS;
  }

  isTerminalThread(threadId: string): boolean {
    return this.terminalThreads.has(threadId);
  }

  markTerminalThread(threadId: string, parentThreadId: string): void {
    // Late spawn evidence must not regrant executable hook authority.
    this.terminalThreads.set(threadId, parentThreadId);
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

  clearTerminalThreadsForParent(parentThreadId: string): void {
    for (const [threadId, parent] of this.terminalThreads) {
      if (parent === parentThreadId) {
        this.terminalThreads.delete(threadId);
      }
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
              fallback.completedAt ?? Date.now(),
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
    this.clearRecoveryTimers(childState);
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

  clearRecoveryTimers(childState: ChildState): void {
    clearTimeout(childState.recoveryTimer);
    childState.recoveryTimer = undefined;
  }
}

export function logRecoveryFailure(childThreadId: string, error: unknown): void {
  embeddedAgentLog.debug("Codex native subagent history is not ready", {
    childThreadId,
    error: formatErrorMessage(error),
  });
}
