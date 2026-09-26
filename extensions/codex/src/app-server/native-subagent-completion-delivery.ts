import { isDurableAgentHarnessCompletionDelivery } from "openclaw/plugin-sdk/agent-harness-completion";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readCodexNativeSubagentRunId } from "./native-subagent-assignment.js";
import { assertHistoryOwnerMatchesRegistration } from "./native-subagent-history-owner.js";
import type {
  ChildState,
  NativeSubagentMonitorRuntime,
  ParentState,
} from "./native-subagent-monitor-types.js";
import { delayForAttempt } from "./native-subagent-retry.js";

type CompletionDeliveryDependencies = {
  deliver: NativeSubagentMonitorRuntime["deliverAgentHarnessCompletion"];
  now: () => number;
  retryDelaysMs?: readonly number[];
  maxRetries?: number;
  isCurrentChild: (child: ChildState) => boolean;
  isCurrentParent: (state: ParentState) => boolean;
  isRetiredParent: (state: ParentState) => boolean;
  getParent: (parentThreadId: string) => ParentState | undefined;
  unregisterChild: (child: ChildState) => void;
  releaseClientRetentionIfIdle: () => void;
};

const DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS = [
  5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];
const completionDeliveryOwners = new Map<string, ChildState>();

export class CodexNativeSubagentCompletionDelivery {
  private readonly retryDelaysMs: readonly number[];
  private readonly maxRetries: number;
  private readonly attempts = new Map<ChildState, Promise<void>>();

  constructor(private readonly dependencies: CompletionDeliveryDependencies) {
    this.retryDelaysMs = dependencies.retryDelaysMs ?? DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS;
    this.maxRetries = dependencies.maxRetries ?? this.retryDelaysMs.length;
  }

  deliverPending(state: ParentState, childState: ChildState): Promise<void> {
    const existing = this.attempts.get(childState);
    if (existing) {
      return existing;
    }
    const attempt = this.deliverAttempt(state, childState);
    this.attempts.set(childState, attempt);
    const release = () => {
      if (this.attempts.get(childState) === attempt) {
        this.attempts.delete(childState);
      }
    };
    void attempt.then(release, release);
    return attempt;
  }

  private async deliverAttempt(state: ParentState, childState: ChildState): Promise<void> {
    const completion = childState.pendingCompletion;
    if (
      !completion ||
      !this.dependencies.isCurrentChild(childState) ||
      !this.dependencies.isCurrentParent(state) ||
      this.dependencies.isRetiredParent(state)
    ) {
      return;
    }
    if (childState.deliveringCompletion || childState.completionDeliveryTimer) {
      return;
    }
    childState.deliveringCompletion = true;
    let deferredToForeground = false;
    try {
      if (!this.prepareDelivery(state, childState)) {
        return;
      }
      // Foreground parents receive native completion input. Only wake a detached
      // parent after its last owner leaves; native receipts deduplicate both paths.
      if (state.owners.size > 0 || !state.completionScope) {
        deferredToForeground = state.owners.size > 0;
        return;
      }
      const historyOwner = childState.historyOwner;
      const delivery = await this.dependencies.deliver({
        scope: state.completionScope,
        completionCustody: childState.completionCustody,
        ...(historyOwner
          ? {
              expectedRequester: {
                sessionId: historyOwner.sessionId,
                lifecycleRevision: historyOwner.lifecycleRevision,
              },
            }
          : {}),
        isSourceSessionAdmissionAllowed: () =>
          this.dependencies.isCurrentChild(childState) &&
          this.dependencies.isCurrentParent(state) &&
          !this.dependencies.isRetiredParent(state) &&
          this.claim(state, childState),
        childSessionKey: childState.runId,
        childSessionId: completion.childThreadId,
        announceId: `codex-native:${childState.nativeParentThreadId}:${readCodexNativeSubagentRunId(childState.runId)?.turnId ? childState.runId : completion.childThreadId}:${completion.status}`,
        announceType: "Subagent",
        taskLabel: "Subagent",
        status: completion.status,
        statusLabel: completion.statusLabel,
        result: completion.result,
        replyInstruction:
          "Use the Codex native subagent result to continue or wrap up the parent task. If this is a Discord/channel session, send the visible response with the message tool instead of only writing a transcript final answer. Reply in your normal assistant voice and do not expose internal notification markup.",
      });
      if (
        !this.dependencies.isCurrentChild(childState) ||
        !this.dependencies.isCurrentParent(state) ||
        this.dependencies.isRetiredParent(state)
      ) {
        return;
      }
      // Keep accepted delivery before a fallible ownership read. A retry cannot
      // deliver it again, including when a native receipt arrives during handoff.
      if (isDurableAgentHarnessCompletionDelivery(delivery)) {
        childState.nativeCompletionDelivered = true;
      }
      if (childState.nativeCompletionDelivered) {
        this.prepareDelivery(state, childState);
        return;
      }
      if (!this.claim(state, childState)) {
        this.dependencies.unregisterChild(childState);
        return;
      }
      if (delivery.recoveryBlocked) {
        this.dependencies.unregisterChild(childState);
        return;
      }
      if (delivery.recoveryPending) {
        this.scheduleRetry(
          childState,
          delivery.error ?? "requester recovery owns completion",
          false,
        );
        return;
      }
      const error = delivery.error ?? "completion delivery did not produce a parent response";
      this.scheduleRetry(childState, error);
    } catch (error) {
      if (
        !this.dependencies.isCurrentChild(childState) ||
        !this.dependencies.isCurrentParent(state) ||
        this.dependencies.isRetiredParent(state)
      ) {
        return;
      }
      if (!this.claim(state, childState)) {
        this.dependencies.unregisterChild(childState);
        return;
      }
      const message = formatErrorMessage(error);
      this.scheduleRetry(childState, message);
      embeddedAgentLog.warn("Failed to deliver Codex native subagent completion", {
        parentThreadId: state.parentThreadId,
        childThreadId: completion.childThreadId,
        error: message,
      });
    } finally {
      if (!deferredToForeground) {
        // Keep the root through the first handoff, including a foreground parent's
        // pending unregister. Once attempted, sleeping retries retain only delivery authority.
        childState.completionCustody?.settleExecution();
      }
      childState.deliveringCompletion = false;
    }
  }

  finish(state: ParentState, child: ChildState): void {
    if (child.completionDeliveryTimer) {
      clearTimeout(child.completionDeliveryTimer);
      child.completionDeliveryTimer = undefined;
    }
    void this.deliverPending(state, child);
  }

  applyReceipts(
    state: ParentState,
    runIds: readonly string[],
    children: ReadonlyMap<string, ChildState>,
  ): void {
    for (const runId of runIds) {
      const child = children.get(runId);
      const deliveryParent = child && this.dependencies.getParent(child.parentThreadId);
      if (
        !child ||
        !deliveryParent ||
        !this.dependencies.isCurrentChild(child) ||
        !this.dependencies.isCurrentParent(state) ||
        this.dependencies.isRetiredParent(state) ||
        !this.dependencies.isCurrentParent(deliveryParent) ||
        this.dependencies.isRetiredParent(deliveryParent)
      ) {
        continue;
      }
      if (deliveryParent !== state) {
        if (
          !state.requesterSessionKey?.trim() ||
          state.requesterSessionKey !== deliveryParent.requesterSessionKey
        ) {
          continue;
        }
        try {
          // A rotated observer can receive an earlier assignment's result, but
          // its saved physical requester must match the observer and delivery owner.
          assertHistoryOwnerMatchesRegistration(
            child.historyOwner,
            state.historyOwner,
            child.nativeParentThreadId,
            true,
          );
        } catch {
          continue;
        }
        if (!this.claim(deliveryParent, child)) {
          continue;
        }
      }
      child.nativeCompletionDelivered = true;
      if (child.pendingCompletion && !child.deliveringCompletion) {
        this.finish(deliveryParent, child);
      }
    }
  }

  deliverDetached(state: ParentState, children: Iterable<ChildState>): void {
    for (const child of children) {
      if (child.parentThreadId === state.parentThreadId && child.pendingCompletion) {
        void this.deliverPending(state, child);
      }
    }
  }

  release(childState: ChildState): void {
    childState.completionCustody?.release();
    if (childState.completionDeliveryTimer) {
      clearTimeout(childState.completionDeliveryTimer);
    }
    const deliveryOwnerKey = childState.deliveryOwnerKey;
    if (deliveryOwnerKey && completionDeliveryOwners.get(deliveryOwnerKey) === childState) {
      completionDeliveryOwners.delete(deliveryOwnerKey);
    }
    childState.deliveryOwnerKey = undefined;
  }

  private prepareDelivery(state: ParentState, child: ChildState): boolean {
    if (!child.pendingCompletion) {
      return false;
    }
    if (!this.claim(state, child) || !state.requesterSessionKey || !state.completionScope) {
      this.dependencies.unregisterChild(child);
      return false;
    }
    if (child.nativeCompletionDelivered) {
      child.pendingCompletion = undefined;
      this.dependencies.unregisterChild(child);
      return false;
    }
    this.dependencies.releaseClientRetentionIfIdle();
    return true;
  }

  private scheduleRetry(childState: ChildState, error: string, chargeAttempt = true): void {
    if (
      !childState.pendingCompletion ||
      childState.completionDeliveryTimer ||
      !this.dependencies.isCurrentChild(childState)
    ) {
      return;
    }
    if (chargeAttempt && childState.completionDeliveryAttempt >= this.maxRetries) {
      embeddedAgentLog.warn("Native subagent completion retries exhausted", {
        childThreadId: childState.childThreadId,
        error,
      });
      this.dependencies.unregisterChild(childState);
      return;
    }
    const delayMs = delayForAttempt(
      this.retryDelaysMs,
      chargeAttempt ? childState.completionDeliveryAttempt++ : childState.completionDeliveryAttempt,
    );
    childState.completionDeliveryTimer = setTimeout(() => {
      childState.completionDeliveryTimer = undefined;
      if (!this.dependencies.isCurrentChild(childState)) {
        return;
      }
      const state = this.dependencies.getParent(childState.parentThreadId);
      if (state) {
        void this.deliverPending(state, childState);
      }
    }, delayMs);
    childState.completionDeliveryTimer.unref();
  }

  private claim(state: ParentState, childState: ChildState): boolean {
    if (childState.completionCustody && !childState.completionCustody.isCurrent()) {
      return false;
    }
    const requesterSessionKey = state.requesterSessionKey?.trim();
    if (!requesterSessionKey) {
      return true;
    }
    const key = `${requesterSessionKey}\0${childState.runId}`;
    try {
      state.assignmentStore?.assertCurrent();
      assertHistoryOwnerMatchesRegistration(
        childState.historyOwner,
        state.historyOwner,
        childState.nativeParentThreadId,
        state.historyOwner !== undefined,
      );
    } catch (error) {
      embeddedAgentLog.warn("Holding native completion with unresolved history owner", {
        childThreadId: childState.childThreadId,
        error: formatErrorMessage(error),
      });
      return false;
    }
    const owner = completionDeliveryOwners.get(key);
    if (owner) {
      return owner === childState;
    }
    // Delivery no longer needs the app-server client. Keep one process owner
    // across client replacement so fallback steering cannot inject twice.
    completionDeliveryOwners.set(key, childState);
    childState.deliveryOwnerKey = key;
    return true;
  }
}
