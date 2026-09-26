import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  AgentHarnessTaskAssignmentOwnerRetiredError,
  AgentHarnessTaskAssignmentUnsupportedError,
  isDurableAgentHarnessCompletionDelivery,
  matchesAgentHarnessTaskAssignment,
  type AgentHarnessTaskRecord,
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
type CompletionAttemptTrigger = "delivery" | "receipt";
type CompletionAttemptRequest = { deliver: boolean };

export class CodexNativeSubagentCompletionDelivery {
  private readonly retryDelaysMs: readonly number[];
  private readonly maxRetries: number;
  private readonly attempts = new Map<
    ChildState,
    { promise: Promise<void>; request: CompletionAttemptRequest }
  >();
  private readonly receiptRetryTimers = new Set<ChildState>();
  private readonly pendingReceipts = new Map<ChildState, Set<ParentState["historyOwner"]>>();
  private readonly exhausted = new Map<ChildState, string>();

  constructor(private readonly dependencies: CompletionDeliveryDependencies) {
    this.retryDelaysMs = dependencies.retryDelaysMs ?? DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS;
    this.maxRetries = dependencies.maxRetries ?? this.retryDelaysMs.length;
  }

  deliverPending(
    state: ParentState,
    childState: ChildState,
    trigger: CompletionAttemptTrigger = "delivery",
  ): Promise<void> {
    if (trigger === "delivery" && this.receiptRetryTimers.delete(childState)) {
      clearTimeout(childState.completionDeliveryTimer);
      childState.completionDeliveryTimer = undefined;
    }
    const existing = this.attempts.get(childState);
    if (existing) {
      if (trigger === "delivery" && !childState.completionDeliveryTimer) {
        existing.request.deliver = true;
      }
      return existing.promise;
    }
    const request = { deliver: trigger === "delivery" };
    const promise = this.deliverAttempt(state, childState, request);
    const attempt = { promise, request };
    this.attempts.set(childState, attempt);
    const release = () => {
      if (this.attempts.get(childState) === attempt) {
        this.attempts.delete(childState);
      }
    };
    void promise.then(release, release);
    return promise;
  }

  private async deliverAttempt(
    state: ParentState,
    childState: ChildState,
    request: CompletionAttemptRequest,
  ): Promise<void> {
    const completion = childState.pendingCompletion;
    if (!completion || !this.isCurrent(state, childState)) {
      return;
    }
    if (
      childState.deliveringCompletion ||
      (childState.completionDeliveryTimer && request.deliver)
    ) {
      return;
    }
    childState.deliveringCompletion = true;
    let deferredToForeground = false;
    try {
      const read = state.taskRuntime?.prepareTaskRunRead
        ? await state.taskRuntime.prepareTaskRunRead(childState.runId)
        : () =>
            state.taskRuntime
              ?.listTaskRecords()
              .filter((task) => task.runId === childState.runId) ?? [];
      if (!this.isCurrent(state, childState)) {
        return;
      }
      this.applyPendingReceipts(state, childState, read);
      // An observer receipt grants no delivery authority until its saved owner matches.
      // A real retry that arrives during the read promotes this same owned attempt.
      if (!request.deliver && !childState.nativeCompletionDelivered) {
        return;
      }
      if (childState.nativeCompletionDelivered && childState.completionDeliveryTimer) {
        clearTimeout(childState.completionDeliveryTimer);
        childState.completionDeliveryTimer = undefined;
        this.receiptRetryTimers.delete(childState);
      }
      if (!(await this.persistPending(state, childState, read))) {
        return;
      }
      const exhaustedError = this.exhausted.get(childState);
      if (exhaustedError !== undefined) {
        const params = {
          runId: childState.runId,
          expectedTask: childState.expectedTask,
          completionCustody: childState.completionCustody,
          deliveryStatus: "failed" as const,
          error: exhaustedError,
        };
        const updated = state.taskRuntime?.setDetachedTaskDeliveryStatusByRunIdAsync
          ? await state.taskRuntime.setDetachedTaskDeliveryStatusByRunIdAsync(params)
          : state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId(params);
        if (!this.isCurrent(state, childState)) {
          return;
        }
        this.applyPendingReceipts(state, childState, read);
        if (childState.nativeCompletionDelivered) {
          childState.completionTaskPhase = "delivery";
          await this.persistPending(state, childState, read);
          return;
        }
        if (
          state.taskRuntime &&
          !updated?.some((task) => this.matchesAssignment(childState, task))
        ) {
          if (this.claim(state, childState, read)) {
            throw new Error("Codex native subagent failed delivery status was not persisted.");
          }
        }
        this.dependencies.unregisterChild(childState);
        return;
      }
      // Foreground parents already receive native completion input. Persist the
      // result now, but only wake a detached parent after its last owner leaves.
      if (state.owners.size > 0 || !state.taskRuntimeScope) {
        deferredToForeground = state.owners.size > 0;
        return;
      }
      const task = read()[0];
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
          this.isCurrent(state, childState) && this.claim(state, childState, read),
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
      // Retain an accepted delivery before any fallible persistence or read.
      // A status-write retry must never send that result a second time.
      if (isDurableAgentHarnessCompletionDelivery(delivery)) {
        childState.nativeCompletionDelivered = true;
      }
      if (childState.nativeCompletionDelivered) {
        childState.completionTaskPhase = "delivery";
        await this.persistPending(state, childState, read);
        return;
      }
      if (!this.claim(state, childState, read)) {
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
      const params = {
        runId: childState.runId,
        expectedTask: childState.expectedTask,
        completionCustody: childState.completionCustody,
        deliveryStatus: "pending" as const,
        error,
      };
      if (state.taskRuntime?.setDetachedTaskDeliveryStatusByRunIdAsync) {
        await state.taskRuntime.setDetachedTaskDeliveryStatusByRunIdAsync(params);
      } else {
        state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId(params);
      }
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
      // Storage may be the failed dependency. Keep custody and schedule using
      // resident state only; the next attempt revalidates the exact assignment.
      const message = formatErrorMessage(error);
      const receiptOnly = !request.deliver && !childState.nativeCompletionDelivered;
      this.scheduleRetry(childState, message, !receiptOnly, receiptOnly ? "receipt" : "delivery");
      embeddedAgentLog.warn("Failed to deliver Codex native subagent completion", {
        parentThreadId: state.parentThreadId,
        childThreadId: completion.childThreadId,
        error: message,
      });
    } finally {
      if (
        (request.deliver || childState.nativeCompletionDelivered) &&
        !childState.completionTaskPhase &&
        !deferredToForeground
      ) {
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
      this.receiptRetryTimers.delete(child);
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
        const receipts = this.pendingReceipts.get(child) ?? new Set<ParentState["historyOwner"]>();
        receipts.add(state.historyOwner);
        this.pendingReceipts.set(child, receipts);
        if (child.pendingCompletion && !child.deliveringCompletion) {
          void this.deliverPending(deliveryParent, child, "receipt");
        }
        continue;
      }
      child.nativeCompletionDelivered = true;
      if (child.pendingCompletion) {
        child.completionTaskPhase ??= "delivery";
      }
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
    this.receiptRetryTimers.delete(childState);
    this.pendingReceipts.delete(childState);
    this.exhausted.delete(childState);
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

  private matchesAssignment(child: ChildState, task: AgentHarnessTaskRecord): boolean {
    return (
      task.runId === child.runId &&
      (!child.expectedTask || matchesAgentHarnessTaskAssignment(task, child.expectedTask))
    );
  }

  private applyPendingReceipts(
    state: ParentState,
    child: ChildState,
    read: () => AgentHarnessTaskRecord[],
  ): void {
    const receipts = this.pendingReceipts.get(child);
    if (!receipts) {
      return;
    }
    const task = read()[0];
    for (const historyOwner of receipts) {
      try {
        assertHistoryOwnerMatchesRegistration(
          readCodexNativeSubagentHistoryOwner(task?.detail),
          historyOwner,
          child.nativeParentThreadId,
          true,
        );
      } catch {
        continue;
      }
      if (this.claim(state, child, read)) {
        child.nativeCompletionDelivered = true;
        if (child.pendingCompletion) {
          child.completionTaskPhase ??= "delivery";
        }
        break;
      }
    }
    this.pendingReceipts.delete(child);
  }

  private async persistPending(
    state: ParentState,
    child: ChildState,
    read: () => AgentHarnessTaskRecord[],
  ): Promise<boolean> {
    const completion = child.pendingCompletion;
    if (!completion) {
      return false;
    }
    const runId = child.runId;
    if (!this.isCurrent(state, child) || !this.claim(state, child, read)) {
      this.dependencies.unregisterChild(child);
      return false;
    }
    if (child.completionTaskPhase === "finalize") {
      const eventAt = completion.completedAt ?? this.dependencies.now();
      const currentRecord = read()[0];
      const params = {
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
      };
      const updated = state.taskRuntime?.finalizeTaskRunByRunIdAsync
        ? await state.taskRuntime.finalizeTaskRunByRunIdAsync(params)
        : state.taskRuntime?.finalizeTaskRunByRunId(params);
      if (!this.isCurrent(state, child)) {
        return false;
      }
      if (state.taskRuntime && !updated?.some((task) => this.matchesAssignment(child, task))) {
        const current = read()[0];
        // Recovery can rewrite an already-terminal outcome still awaiting delivery.
        // Lost assignment ownership or a conflicting terminal decision retires this projection.
        if (
          !this.claim(state, child, read) ||
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
    this.applyPendingReceipts(state, child, read);
    if (child.completionTaskPhase === "delivery") {
      const params = {
        runId,
        expectedTask: child.expectedTask,
        completionCustody: child.completionCustody,
        deliveryStatus: child.nativeCompletionDelivered
          ? ("delivered" as const)
          : ("pending" as const),
      };
      const updated = state.taskRuntime?.setDetachedTaskDeliveryStatusByRunIdAsync
        ? await state.taskRuntime.setDetachedTaskDeliveryStatusByRunIdAsync(params)
        : state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId(params);
      if (!this.isCurrent(state, child)) {
        return false;
      }
      if (state.taskRuntime && !updated?.some((task) => this.matchesAssignment(child, task))) {
        if (!this.claim(state, child, read)) {
          this.dependencies.unregisterChild(child);
          return false;
        }
        throw new Error("Codex native subagent task delivery status was not persisted.");
      }
      this.applyPendingReceipts(state, child, read);
      if (params.deliveryStatus === "pending" && child.nativeCompletionDelivered) {
        // Native delivery can arrive while the pending-status worker is settling.
        return this.persistPending(state, child, read);
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

  private scheduleRetry(
    childState: ChildState,
    error: string,
    chargeAttempt = true,
    trigger: CompletionAttemptTrigger = "delivery",
  ): void {
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
      // Exhaustion settles through the same owned attempt. A failed status write
      // remains pending without starting another delivery or escaping this timer.
      if (!this.exhausted.has(childState)) {
        this.exhausted.set(childState, error);
      }
    }
    const delayMs = delayForAttempt(
      this.retryDelaysMs,
      chargeAttempt ? childState.completionDeliveryAttempt++ : childState.completionDeliveryAttempt,
    );
    if (trigger === "receipt") {
      this.receiptRetryTimers.add(childState);
    }
    childState.completionDeliveryTimer = setTimeout(() => {
      this.receiptRetryTimers.delete(childState);
      childState.completionDeliveryTimer = undefined;
      if (!this.dependencies.isCurrentChild(childState)) {
        return;
      }
      const state = this.dependencies.getParent(childState.parentThreadId);
      if (state) {
        void this.deliverPending(state, childState, trigger);
      }
    }, delayMs);
    childState.completionDeliveryTimer.unref();
  }

  private claim(
    state: ParentState,
    childState: ChildState,
    read: () => AgentHarnessTaskRecord[],
  ): boolean {
    if (childState.completionCustody && !childState.completionCustody.isCurrent()) {
      return false;
    }
    const requesterSessionKey = state.requesterSessionKey?.trim();
    if (!requesterSessionKey) {
      return true;
    }
    const key = `${requesterSessionKey}\0${childState.runId}`;
    const tasks = read();
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
