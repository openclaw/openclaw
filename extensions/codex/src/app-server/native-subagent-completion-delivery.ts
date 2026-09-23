import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  AgentHarnessTaskAssignmentOwnerRetiredError,
  AgentHarnessTaskAssignmentUnsupportedError,
  isDurableAgentHarnessCompletionDelivery,
  matchesAgentHarnessTaskAssignment,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import {
  readCodexNativeSubagentHistoryOwner,
  assertHistoryOwnerMatchesRegistration,
} from "./native-subagent-history-owner.js";
import type {
  ChildState,
  NativeSubagentMonitorRuntime,
  ParentState,
} from "./native-subagent-monitor-types.js";
import { delayForAttempt } from "./native-subagent-retry.js";
import { readCodexNativeSubagentRunId } from "./native-subagent-task-ids.js";
import { isJsonObject } from "./protocol.js";

type CompletionDeliveryDependencies = {
  deliver: NativeSubagentMonitorRuntime["deliverAgentHarnessTaskCompletion"];
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

  constructor(private readonly dependencies: CompletionDeliveryDependencies) {
    this.retryDelaysMs = dependencies.retryDelaysMs ?? DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS;
    this.maxRetries = dependencies.maxRetries ?? this.retryDelaysMs.length;
  }

  async deliverPending(state: ParentState, childState: ChildState): Promise<void> {
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
      if (!this.persistPending(state, childState)) {
        return;
      }
      // Foreground parents already receive native completion input. Persist the
      // result now, but only wake a detached parent after its last owner leaves.
      if (state.owners.size > 0 || !state.taskRuntimeScope) {
        deferredToForeground = state.owners.size > 0;
        return;
      }
      const task = state.taskRuntime
        ?.listTaskRecords()
        .find((record) => record.runId === childState.runId);
      const historyOwner = readCodexNativeSubagentHistoryOwner(task?.detail);
      const delivery = await this.dependencies.deliver({
        scope: state.taskRuntimeScope,
        completionCustody: childState.completionCustody,
        expectedTask: childState.expectedTask,
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
        !this.dependencies.isCurrentParent(state)
      ) {
        return;
      }
      if (!this.claim(state, childState)) {
        this.dependencies.unregisterChild(childState);
        return;
      }
      if (isDurableAgentHarnessCompletionDelivery(delivery)) {
        childState.nativeCompletionDelivered = true;
        childState.completionTaskPhase = "delivery";
        this.persistPending(state, childState);
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
      state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
        runId: childState.runId,
        expectedTask: childState.expectedTask,
        completionCustody: childState.completionCustody,
        deliveryStatus: "pending",
        error,
      });
      this.scheduleRetry(childState, error);
    } catch (error) {
      if (
        error instanceof AgentHarnessTaskAssignmentUnsupportedError ||
        error instanceof AgentHarnessTaskAssignmentOwnerRetiredError
      ) {
        // Neither permanent owner failure can be repaired by retrying this assignment.
        // Retire it before a finalize-phase retry can retain the Gateway root indefinitely.
        this.dependencies.unregisterChild(childState);
        embeddedAgentLog.warn(error.message);
        return;
      }
      if (
        !this.dependencies.isCurrentChild(childState) ||
        !this.dependencies.isCurrentParent(state)
      ) {
        return;
      }
      if (!this.claim(state, childState)) {
        this.dependencies.unregisterChild(childState);
        return;
      }
      const message = formatErrorMessage(error);
      if (!childState.completionTaskPhase) {
        state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
          runId: childState.runId,
          expectedTask: childState.expectedTask,
          completionCustody: childState.completionCustody,
          deliveryStatus: "pending",
          error: message,
        });
      }
      this.scheduleRetry(childState, message);
      embeddedAgentLog.warn("Failed to deliver Codex native subagent completion", {
        parentThreadId: state.parentThreadId,
        childThreadId: completion.childThreadId,
        error: message,
      });
    } finally {
      if (!childState.completionTaskPhase && !deferredToForeground) {
        // Keep the root through the first handoff, including a foreground parent's
        // pending unregister. Once attempted, sleeping retries retain only delivery authority.
        childState.completionCustody?.settleExecution();
      }
      childState.deliveringCompletion = false;
    }
  }

  finish(state: ParentState, child: ChildState): void {
    child.completionTaskPhase ??= "delivery";
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
        const task = deliveryParent.taskRuntime
          ?.listTaskRecords()
          .find((record) => record.runId === runId);
        try {
          // A rotated observer can receive an earlier assignment's result, but
          // its saved physical requester must match the observer and delivery owner.
          assertHistoryOwnerMatchesRegistration(
            readCodexNativeSubagentHistoryOwner(task?.detail),
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

  private persistPending(state: ParentState, child: ChildState): boolean {
    const completion = child.pendingCompletion;
    if (!completion) {
      return false;
    }
    const runId = child.runId;
    if (!this.claim(state, child)) {
      this.dependencies.unregisterChild(child);
      return false;
    }
    if (child.completionTaskPhase === "finalize") {
      const eventAt = completion.completedAt ?? this.dependencies.now();
      const currentRecord = state.taskRuntime
        ?.listTaskRecords()
        .find((record) => record.runId === runId);
      const updated = state.taskRuntime?.finalizeTaskRunByRunId({
        runId,
        expectedTask: child.expectedTask,
        completionCustody: child.completionCustody,
        status: completion.status,
        endedAt: eventAt,
        lastEventAt: eventAt,
        ...(completion.status === "succeeded" ? {} : { error: completion.result }),
        progressSummary: completion.result,
        terminalSummary: completion.result,
        ...(child.nativeTurnId
          ? {
              detail: {
                ...(isJsonObject(currentRecord?.detail) ? currentRecord.detail : {}),
                nativeTurnId: child.nativeTurnId,
              },
            }
          : {}),
      });
      if (
        state.taskRuntime &&
        !updated?.some(
          (task) =>
            task.runId === runId &&
            (!child.expectedTask || matchesAgentHarnessTaskAssignment(task, child.expectedTask)),
        )
      ) {
        const current = state.taskRuntime.listTaskRecords().find((task) => task.runId === runId);
        // Recovery can rewrite an already-terminal outcome still awaiting delivery.
        // Only absence or a conflicting terminal decision retires this projection.
        if (
          !current ||
          (current.status !== completion.status &&
            current.status !== "queued" &&
            current.status !== "running")
        ) {
          this.dependencies.unregisterChild(child);
          return false;
        }
        throw new Error("Codex native subagent task finalization was not persisted.");
      }
      child.completionTaskPhase = "delivery";
    }
    if (!state.requesterSessionKey || !state.taskRuntimeScope) {
      this.dependencies.unregisterChild(child);
      return false;
    }
    if (child.completionTaskPhase === "delivery") {
      const updated = state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
        runId,
        expectedTask: child.expectedTask,
        completionCustody: child.completionCustody,
        deliveryStatus: child.nativeCompletionDelivered ? "delivered" : "pending",
      });
      if (
        state.taskRuntime &&
        !updated?.some(
          (task) =>
            task.runId === runId &&
            (!child.expectedTask || matchesAgentHarnessTaskAssignment(task, child.expectedTask)),
        )
      ) {
        if (!state.taskRuntime.listTaskRecords().some((task) => task.runId === runId)) {
          this.dependencies.unregisterChild(child);
          return false;
        }
        throw new Error("Codex native subagent task delivery status was not persisted.");
      }
      child.completionTaskPhase = undefined;
      child.completionDeliveryAttempt = 0;
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
    if (
      chargeAttempt &&
      !childState.completionTaskPhase &&
      childState.completionDeliveryAttempt >= this.maxRetries
    ) {
      const state = this.dependencies.getParent(childState.parentThreadId);
      state?.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
        runId: childState.runId,
        expectedTask: childState.expectedTask,
        completionCustody: childState.completionCustody,
        deliveryStatus: "failed",
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
    const runId = childState.runId;
    const tasks =
      state.taskRuntime?.listTaskRecords().filter((record) => record.runId === runId) ?? [];
    const task = tasks[0];
    if (
      tasks.length > 1 ||
      (state.taskRuntime &&
        (!childState.expectedTask ||
          !task ||
          !matchesAgentHarnessTaskAssignment(task, childState.expectedTask)))
    ) {
      return false;
    }
    if (task?.deliveryStatus === "delivered") {
      return false;
    }
    try {
      assertHistoryOwnerMatchesRegistration(
        readCodexNativeSubagentHistoryOwner(task?.detail),
        state.historyOwner,
        childState.nativeParentThreadId,
        childState.requiresHistoryOwner === true,
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
