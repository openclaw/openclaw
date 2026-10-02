import { isDurableAgentHarnessCompletionDelivery } from "openclaw/plugin-sdk/agent-harness-completion";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readCodexNativeSubagentRunId } from "./native-subagent-assignment.js";
import { assertHistoryOwnerMatchesRegistration } from "./native-subagent-history-owner.js";
import { CodexNativeCompletionOwnerError } from "./native-subagent-pending-assignments.js";
import type {
  ChildState,
  NativeSubagentMonitorRuntime,
  ParentState,
} from "./native-subagent-monitor-types.js";
import { delayForAttempt } from "./native-subagent-retry.js";

type CompletionDeliveryDependencies = {
  deliver: NativeSubagentMonitorRuntime["deliverAgentHarnessCompletion"];
  retryDelaysMs?: readonly number[];
  maxRetries?: number;
  /** Uncharged owner-resolution waits; defaults to the retry ladder length. */
  maxOwnerHolds?: number;
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

type DeliveryClaim =
  | { ok: true }
  | { ok: false; reason: string; retryable: boolean; error?: string };
const CLAIMED: DeliveryClaim = { ok: true };

export class CodexNativeSubagentCompletionDelivery {
  private readonly retryDelaysMs: readonly number[];
  private readonly maxRetries: number;
  private readonly maxOwnerHolds: number;
  private readonly attempts = new Map<ChildState, Promise<void>>();

  constructor(private readonly dependencies: CompletionDeliveryDependencies) {
    this.retryDelaysMs = dependencies.retryDelaysMs ?? DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS;
    this.maxRetries = dependencies.maxRetries ?? this.retryDelaysMs.length;
    this.maxOwnerHolds = dependencies.maxOwnerHolds ?? this.retryDelaysMs.length;
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
    if (!completion || !this.isCurrent(state, childState)) {
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
          this.isCurrent(state, childState) && this.claim(state, childState).ok,
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
      if (!this.isCurrent(state, childState)) {
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
      const claim = this.claim(state, childState);
      if (!claim.ok) {
        this.holdOrDrop(childState, claim);
        return;
      }
      if (delivery.recoveryBlocked) {
        this.drop(childState, "requester-recovery-blocked", delivery.error);
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
      if (!this.isCurrent(state, childState)) {
        return;
      }
      const claim = this.claim(state, childState);
      if (!claim.ok) {
        this.holdOrDrop(childState, claim);
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
        !this.isCurrent(state, child) ||
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
        if (!this.claim(deliveryParent, child).ok) {
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

  private isCurrent(state: ParentState, child: ChildState): boolean {
    return (
      this.dependencies.isCurrentChild(child) &&
      this.dependencies.isCurrentParent(state) &&
      !this.dependencies.isRetiredParent(state)
    );
  }

  private prepareDelivery(state: ParentState, child: ChildState): boolean {
    if (!child.pendingCompletion) {
      return false;
    }
    const claim = this.claim(state, child);
    if (child.nativeCompletionDelivered) {
      // Already delivered (announce or native receipt): settle regardless of
      // the ownership read, which a rotation-creating announce may have moved.
      child.pendingCompletion = undefined;
      this.dependencies.unregisterChild(child);
      return false;
    }
    if (!claim.ok) {
      this.holdOrDrop(child, claim);
      return false;
    }
    if (!state.requesterSessionKey || !state.completionScope) {
      // Foreground-only parents receive native completion input instead.
      embeddedAgentLog.debug("Native completion has no detached requester scope", {
        childThreadId: child.childThreadId,
      });
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
    this.armRetry(childState, delayMs);
  }

  private armRetry(childState: ChildState, delayMs: number): void {
    childState.completionDeliveryTimer = setTimeout(() => {
      childState.completionDeliveryTimer = undefined;
      if (!this.dependencies.isCurrentChild(childState)) {
        return;
      }
      const state = this.dependencies.getParent(childState.parentThreadId);
      if (state) {
        void this.deliverPending(state, childState);
      } else if (childState.pendingCompletion) {
        // Unchanged ownership semantics (restore may re-arm it); only make it visible.
        embeddedAgentLog.warn("Native completion retry has no delivery parent", {
          childThreadId: childState.childThreadId,
          runId: childState.runId,
        });
      }
    }, delayMs);
    childState.completionDeliveryTimer.unref();
  }

  /** Never drop silently: wait (bounded, uncharged) for a resolvable owner, else log why. */
  private holdOrDrop(
    childState: ChildState,
    claim: Extract<DeliveryClaim, { ok: false }>,
  ): void {
    if (claim.retryable && this.scheduleOwnerHold(childState, claim)) {
      return;
    }
    this.drop(childState, claim.reason, claim.error, claim.retryable);
  }

  private scheduleOwnerHold(
    childState: ChildState,
    claim: Extract<DeliveryClaim, { ok: false }>,
  ): boolean {
    if (!childState.pendingCompletion || !this.dependencies.isCurrentChild(childState)) {
      return false;
    }
    if (childState.completionDeliveryTimer) {
      return true;
    }
    const attempt = childState.completionOwnerHoldAttempt ?? 0;
    if (attempt >= this.maxOwnerHolds) {
      return false;
    }
    childState.completionOwnerHoldAttempt = attempt + 1;
    const delayMs = delayForAttempt(this.retryDelaysMs, attempt);
    embeddedAgentLog.warn("Holding native completion with unresolved history owner", {
      childThreadId: childState.childThreadId,
      reason: claim.reason,
      attempt: attempt + 1,
      maxAttempts: this.maxOwnerHolds,
      retryInMs: delayMs,
      ...(claim.error ? { error: claim.error } : {}),
    });
    this.armRetry(childState, delayMs);
    return true;
  }

  private drop(
    childState: ChildState,
    reason: string,
    error?: string,
    ownerHoldsExhausted = false,
  ): void {
    if (childState.pendingCompletion && !childState.nativeCompletionDelivered) {
      embeddedAgentLog.warn("Dropping native completion", {
        childThreadId: childState.childThreadId,
        runId: childState.runId,
        reason,
        ...(ownerHoldsExhausted
          ? { ownerHoldAttempts: childState.completionOwnerHoldAttempt ?? 0 }
          : {}),
        ...(error ? { error } : {}),
      });
    }
    this.dependencies.unregisterChild(childState);
  }

  private claim(state: ParentState, childState: ChildState): DeliveryClaim {
    if (childState.completionCustody && !childState.completionCustody.isCurrent()) {
      return { ok: false, reason: "completion-custody-expired", retryable: false };
    }
    const requesterSessionKey = state.requesterSessionKey?.trim();
    if (!requesterSessionKey) {
      return CLAIMED;
    }
    const key = `${requesterSessionKey}\0${childState.runId}`;
    try {
      // Delivery-only ownership may follow native parent rotation within the
      // same session, lifecycle, and connection. Receipts stay strict.
      const store = state.assignmentStore;
      if (store?.assertDeliveryOwner) {
        store.assertDeliveryOwner();
      } else {
        store?.assertCurrent();
      }
    } catch (error) {
      const ownerError = error instanceof CodexNativeCompletionOwnerError ? error : undefined;
      return {
        ok: false,
        reason: ownerError?.reason ?? "owner-unresolved",
        retryable: ownerError?.retryable ?? true,
        error: formatErrorMessage(error),
      };
    }
    try {
      assertHistoryOwnerMatchesRegistration(
        childState.historyOwner,
        state.historyOwner,
        childState.nativeParentThreadId,
        state.historyOwner !== undefined,
      );
    } catch (error) {
      return {
        ok: false,
        reason: "history-owner-contradictory",
        retryable: false,
        error: formatErrorMessage(error),
      };
    }
    const owner = completionDeliveryOwners.get(key);
    if (owner) {
      return owner === childState
        ? CLAIMED
        : { ok: false, reason: "superseded-delivery-owner", retryable: false };
    }
    // Delivery no longer needs the app-server client. Keep one process owner
    // across client replacement so fallback steering cannot inject twice.
    completionDeliveryOwners.set(key, childState);
    childState.deliveryOwnerKey = key;
    return CLAIMED;
  }
}
