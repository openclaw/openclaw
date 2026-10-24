import { isDurableAgentHarnessCompletionDelivery } from "openclaw/plugin-sdk/agent-harness-completion";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  codexNativeSubagentRunId,
  readCodexNativeSubagentRunId,
} from "./native-subagent-assignment.js";
import { assertHistoryOwnerMatchesRegistration } from "./native-subagent-history-owner.js";
import type {
  ChildState,
  NativeSubagentMonitorRuntime,
  ParentState,
} from "./native-subagent-monitor-types.js";
import { CodexNativeCompletionOwnerError } from "./native-subagent-pending-assignments.js";
import { delayForAttempt } from "./native-subagent-retry.js";

type CompletionDeliveryDependencies = {
  deliver: NativeSubagentMonitorRuntime["deliverAgentHarnessCompletion"];
  children: ReadonlyMap<string, ChildState>;
  parents: ReadonlyMap<string, ParentState>;
  retiredParents: Pick<WeakSet<ParentState>, "has">;
  unregisterChild: (child: ChildState) => void;
  abandon: (state: ParentState, child: ChildState, assertCurrent: () => void) => Promise<void>;
  settleNestedCompletion: (
    state: ParentState,
    child: ChildState,
    assertCurrent: () => void,
  ) => Promise<boolean>;
  releaseClientRetentionIfIdle: () => void;
};

const COMPLETION_DELIVERY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
const completionDeliveryOwners = new Map<string, ChildState>();

type DeliveryClaim =
  | { ok: true }
  | { ok: false; reason: string; retryable: boolean; error?: string };
const CLAIMED: DeliveryClaim = { ok: true };

export class CodexNativeSubagentCompletionDelivery {
  private readonly attempts = new Map<ChildState, Promise<void>>();

  constructor(private readonly dependencies: CompletionDeliveryDependencies) {}

  deliverPending(state: ParentState, childState: ChildState): Promise<void> {
    const existing = this.attempts.get(childState);
    if (existing) {
      return existing;
    }
    // Publish the shared attempt before releasing a client can synchronously close it.
    const attempt = Promise.resolve().then(() => this.deliverAttempt(state, childState));
    this.attempts.set(childState, attempt);
    const release = () => {
      this.attempts.delete(childState);
    };
    void attempt.then(release, release);
    return attempt;
  }

  async join(child: ChildState): Promise<void> {
    await this.attempts.get(child);
  }

  private async deliverAttempt(state: ParentState, childState: ChildState): Promise<void> {
    const completion = childState.pendingCompletion;
    if (!completion || !this.isCurrent(state, childState)) {
      return;
    }
    if (childState.completionDeliveryTimer) {
      return;
    }
    let deferredToForeground = false;
    try {
      if (childState.cancellationRequested && completion.status === "cancelled") {
        // Stop owns durable cancellation acknowledgement before releasing this child.
        return;
      }
      if (
        await this.dependencies.settleNestedCompletion(state, childState, () => {
          if (
            !this.isCurrent(state, childState) ||
            (childState.completionCustody && !childState.completionCustody.isCurrent())
          ) {
            throw new Error("Native completion acknowledgement is no longer current.");
          }
        })
      ) {
        this.dependencies.unregisterChild(childState);
        return;
      }
      if (!this.isCurrent(state, childState)) {
        return;
      }
      if (!this.prepareDelivery(state, childState)) {
        return;
      }
      if (childState.completionDeliveryAbandoned) {
        await this.abandon(state, childState);
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
        await this.abandon(state, childState);
        return;
      }
      const recoveryPending = delivery.recoveryPending;
      const error =
        delivery.error ??
        (recoveryPending
          ? "requester recovery owns completion"
          : "completion delivery did not produce a parent response");
      await this.scheduleRetry(state, childState, error, !recoveryPending);
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
      await this.scheduleRetry(state, childState, message, !childState.completionDeliveryAbandoned);
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
    }
  }

  finish(state: ParentState, child: ChildState): void {
    clearTimeout(child.completionDeliveryTimer);
    child.completionDeliveryTimer = undefined;
    void this.deliverPending(state, child);
  }

  applyReceipts(state: ParentState, runIds: readonly string[]): void {
    for (const runId of runIds) {
      const child = this.dependencies.children.get(runId);
      const deliveryParent = child && this.dependencies.parents.get(child.parentThreadId);
      if (
        !child ||
        !deliveryParent ||
        !this.isCurrent(state, child) ||
        this.dependencies.parents.get(deliveryParent.parentThreadId) !== deliveryParent ||
        this.dependencies.retiredParents.has(deliveryParent)
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
      if (child.pendingCompletion && !this.attempts.has(child)) {
        this.finish(deliveryParent, child);
      }
    }
  }

  deliverDetached(state: ParentState): void {
    for (const child of this.dependencies.children.values()) {
      if (child.parentThreadId === state.parentThreadId && child.pendingCompletion) {
        void this.deliverPending(state, child);
      }
    }
  }

  release(childState: ChildState): void {
    childState.completionCustody?.release();
    clearTimeout(childState.completionDeliveryTimer);
    const deliveryOwnerKey = childState.deliveryOwnerKey;
    if (deliveryOwnerKey && completionDeliveryOwners.get(deliveryOwnerKey) === childState) {
      completionDeliveryOwners.delete(deliveryOwnerKey);
    }
    childState.deliveryOwnerKey = undefined;
  }

  private isCurrent(state: ParentState, child: ChildState): boolean {
    return (
      this.dependencies.children.get(child.runId) === child &&
      this.dependencies.parents.get(state.parentThreadId) === state &&
      !this.dependencies.retiredParents.has(state)
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

  private async abandon(state: ParentState, child: ChildState): Promise<void> {
    child.completionDeliveryAbandoned = true;
    try {
      await this.dependencies.abandon(state, child, () => {
        if (
          child.nativeCompletionDelivered ||
          !this.isCurrent(state, child) ||
          (child.completionCustody && !child.completionCustody.isCurrent()) ||
          (child.deliveryOwnerKey && completionDeliveryOwners.get(child.deliveryOwnerKey) !== child)
        ) {
          throw new Error("Native completion retirement is no longer current.");
        }
      });
      this.dependencies.unregisterChild(child);
    } catch (error) {
      if (this.isCurrent(state, child) && child.nativeCompletionDelivered) {
        this.prepareDelivery(state, child);
        return;
      }
      embeddedAgentLog.warn("Native completion retirement remains pending", {
        childThreadId: child.childThreadId,
        error: formatErrorMessage(error),
      });
      await this.scheduleRetry(state, child, formatErrorMessage(error), false);
    }
  }

  private async scheduleRetry(
    state: ParentState,
    childState: ChildState,
    error: string,
    chargeAttempt = true,
  ): Promise<void> {
    if (
      !childState.pendingCompletion ||
      childState.completionDeliveryTimer ||
      this.dependencies.children.get(childState.runId) !== childState
    ) {
      return;
    }
    if (
      chargeAttempt &&
      childState.completionDeliveryAttempt >= COMPLETION_DELIVERY_RETRY_DELAYS_MS.length
    ) {
      embeddedAgentLog.warn("Native subagent completion retries exhausted", {
        childThreadId: childState.childThreadId,
        error,
      });
      await this.abandon(state, childState);
      return;
    }
    const delayMs = delayForAttempt(
      COMPLETION_DELIVERY_RETRY_DELAYS_MS,
      chargeAttempt ? childState.completionDeliveryAttempt++ : childState.completionDeliveryAttempt,
    );
    this.armRetry(childState, delayMs);
  }

  private armRetry(childState: ChildState, delayMs: number): void {
    childState.completionDeliveryTimer = setTimeout(() => {
      childState.completionDeliveryTimer = undefined;
      if (this.dependencies.children.get(childState.runId) !== childState) {
        return;
      }
      const currentParent = this.dependencies.parents.get(childState.parentThreadId);
      if (currentParent) {
        void this.deliverPending(currentParent, childState);
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
  private holdOrDrop(childState: ChildState, claim: Extract<DeliveryClaim, { ok: false }>): void {
    if (claim.retryable && this.scheduleOwnerHold(childState, claim)) {
      return;
    }
    this.drop(childState, claim, claim.retryable);
  }

  private scheduleOwnerHold(
    childState: ChildState,
    claim: Extract<DeliveryClaim, { ok: false }>,
  ): boolean {
    if (
      !childState.pendingCompletion ||
      this.dependencies.children.get(childState.runId) !== childState
    ) {
      return false;
    }
    if (childState.completionDeliveryTimer) {
      return true;
    }
    const attempt = childState.completionOwnerHoldAttempt ?? 0;
    if (attempt >= COMPLETION_DELIVERY_RETRY_DELAYS_MS.length) {
      return false;
    }
    childState.completionOwnerHoldAttempt = attempt + 1;
    const delayMs = delayForAttempt(COMPLETION_DELIVERY_RETRY_DELAYS_MS, attempt);
    embeddedAgentLog.warn("Holding native completion with unresolved history owner", {
      childThreadId: childState.childThreadId,
      reason: claim.reason,
      attempt: attempt + 1,
      maxAttempts: COMPLETION_DELIVERY_RETRY_DELAYS_MS.length,
      retryInMs: delayMs,
      ...(claim.error ? { error: claim.error } : {}),
    });
    this.armRetry(childState, delayMs);
    return true;
  }

  private drop(
    childState: ChildState,
    claim: Extract<DeliveryClaim, { ok: false }>,
    ownerHoldsExhausted: boolean,
  ): void {
    if (childState.pendingCompletion && !childState.nativeCompletionDelivered) {
      embeddedAgentLog.warn("Dropping native completion", {
        childThreadId: childState.childThreadId,
        runId: childState.runId,
        reason: claim.reason,
        ...(ownerHoldsExhausted
          ? { ownerHoldAttempts: childState.completionOwnerHoldAttempt ?? 0 }
          : {}),
        ...(claim.error ? { error: claim.error } : {}),
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
    const key =
      childState.deliveryOwnerKey ??
      `${requesterSessionKey}\0${childState.nativeTurnId ? codexNativeSubagentRunId(childState.childThreadId, childState.nativeTurnId) : childState.runId}`;
    try {
      // Delivery-only ownership may follow native parent rotation within the
      // same session and connection. Receipts stay strict.
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
