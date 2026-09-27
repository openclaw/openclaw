import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  captureAgentHarnessTaskAssignment,
  matchesAgentHarnessTaskAssignment,
  type AgentHarnessCompletionCustody,
  type AgentHarnessTaskAssignment,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  ChildState,
  KnownChild,
  MonitorOptions,
  NativeSubagentMonitorClient,
  ParentOwner,
  ParentState,
} from "./native-subagent-monitor-types.js";
import { logRecoveryFailure } from "./native-subagent-recovery-coordinator.js";
import { normalizeIdentifier, readNativeSubagentThreadIds } from "./native-subagent-task-ids.js";
import { isJsonObject, type CodexServerNotification } from "./protocol.js";

type ChildCloseCall = {
  turnId: string;
  owners: Set<ParentOwner>;
  targets: Array<{
    childThreadId: string;
    runId: string;
    nativeTurnId?: string;
    childState?: ChildState;
    expectedTask?: AgentHarnessTaskAssignment;
    completionCustody?: AgentHarnessCompletionCustody;
    forget?: Promise<(() => void) | undefined>;
  }>;
  completionObserved?: true;
  completing?: true;
  settled?: true;
  settlement?: Promise<void>;
};

type NativeSubagentCloseCallbacks = {
  isParentCurrent: (state: ParentState) => boolean;
  isParentRetired: (state: ParentState) => boolean;
  knownChild: (threadId: string) => KnownChild | undefined;
  currentChild: (threadId: string) => ChildState | undefined;
  isRegisteredChild: (child: ChildState) => boolean;
  captureForget?: MonitorOptions["captureChildThreadForget"];
  releaseDirectChild: (child: ChildState) => void;
  clearRecoveryTimers: (child: ChildState) => void;
  markTerminalRevision: (threadId: string) => void;
  unregisterChild: (child: ChildState) => void;
  releaseClientRetentionIfIdle: () => void;
  now: () => number;
  pruneParent: (state: ParentState) => void;
};

export class CodexNativeSubagentCloseOwner {
  private readonly calls = new WeakMap<ParentState, Map<string, ChildCloseCall>>();

  constructor(
    private readonly client: Pick<NativeSubagentMonitorClient, "request">,
    private readonly callbacks: NativeSubagentCloseCallbacks,
  ) {}

  bind(state: ParentState, turnId: string): void {
    this.prune(state);
    for (const [key, call] of this.calls.get(state) ?? []) {
      if (call.completionObserved && call.turnId === turnId) {
        void this.completeChildClose(state, key, call).catch((error: unknown) =>
          logRecoveryFailure(state.parentThreadId, error),
        );
      }
    }
  }

  clear(state: ParentState): void {
    this.calls.delete(state);
  }

  hasPending(state: ParentState): boolean {
    return [...(this.calls.get(state)?.values() ?? [])].some(
      (call) => call.completing && !call.settled,
    );
  }

  settlements(state: ParentState): Promise<void>[] {
    return [...(this.calls.get(state)?.values() ?? [])].flatMap((call) =>
      call.settlement ? [call.settlement] : [],
    );
  }

  async observe(notification: CodexServerNotification, state: ParentState): Promise<void> {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const item = isJsonObject(params?.item) ? params.item : undefined;
    const turnId = readString(params, "turnId");
    const itemId = readString(item, "id");
    const senderThreadId = readString(item, "senderThreadId");
    if (
      !turnId ||
      !itemId ||
      readString(params, "threadId") !== state.parentThreadId ||
      (senderThreadId !== undefined && senderThreadId !== state.parentThreadId) ||
      this.callbacks.isParentRetired(state)
    ) {
      return;
    }
    let calls = this.calls.get(state);
    if (!calls) {
      calls = new Map();
      this.calls.set(state, calls);
    }
    const key = `${turnId}\0${itemId}`;
    const childThreadIds = new Set(readNativeSubagentThreadIds(item?.receiverThreadIds));
    if (notification.method === "item/started") {
      if (calls.has(key)) {
        return;
      }
      const owners = new Set(
        [...state.owners.values()].filter((owner) => !owner.turnId || owner.turnId === turnId),
      );
      if (owners.size === 0) {
        return;
      }
      const targets: ChildCloseCall["targets"] = [];
      for (const childThreadId of childThreadIds) {
        const known = this.callbacks.knownChild(childThreadId);
        if (known?.parent !== state || known.pendingTurns.length > 0) {
          continue;
        }
        const childState = this.callbacks.currentChild(childThreadId);
        targets.push({
          childThreadId,
          runId: known.assignment.runId,
          nativeTurnId: known.turnId,
          childState,
          expectedTask:
            childState?.expectedTask ?? state.mirror?.getTaskAssignment(known.assignment.runId),
          completionCustody: childState?.completionCustody,
          forget: this.callbacks.captureForget?.(childThreadId).catch((error: unknown) => {
            logRecoveryFailure(childThreadId, error);
            return undefined;
          }),
        });
      }
      calls.set(key, { turnId, owners, targets });
      return;
    }
    const call = calls.get(key);
    if (
      !call ||
      call.targets.some((target) => !childThreadIds.has(target.childThreadId)) ||
      childThreadIds.size !== call.targets.length
    ) {
      return;
    }
    call.completionObserved = true;
    await this.completeChildClose(state, key, call);
  }

  prune(state: ParentState): void {
    const calls = this.calls.get(state);
    if (!calls) {
      return;
    }
    for (const [key, call] of calls) {
      if (call.completing && !call.settled) {
        continue;
      }
      if (
        ![...state.owners.values()].some(
          (owner) => call.owners.has(owner) && (!owner.turnId || owner.turnId === call.turnId),
        )
      ) {
        calls.delete(key);
      }
    }
  }

  retireChild(
    state: ParentState,
    childState: ChildState,
    summary: string,
    releaseSubscription?: () => void,
    ownership: Pick<ChildCloseCall["targets"][number], "expectedTask" | "completionCustody"> = {
      expectedTask: childState.expectedTask,
      completionCustody: childState.completionCustody,
    },
  ): Promise<void> {
    const known = this.callbacks.knownChild(childState.childThreadId);
    const nativeTurnId = childState.nativeTurnId;
    const knownTurnId = known?.turnId;
    const isCurrent = () =>
      this.callbacks.isRegisteredChild(childState) &&
      childState.parentThreadId === state.parentThreadId &&
      childState.nativeTurnId === nativeTurnId &&
      (this.callbacks.isParentRetired(state) ||
        (this.callbacks.currentChild(childState.childThreadId) === childState &&
          this.callbacks.knownChild(childState.childThreadId) === known &&
          known?.parent === state &&
          known.assignment.runId === childState.runId &&
          known.turnId === knownTurnId));
    const settle = async () => {
      if (!isCurrent()) {
        return;
      }
      const preserveCompletion = () => {
        if (!childState.pendingCompletion || this.callbacks.isParentRetired(state)) {
          return false;
        }
        // Closing the native child does not discard its already accepted result.
        // Keep its delivery owner, but never warm the closed subscription later.
        childState.subscriptionClosed = true;
        this.callbacks.releaseDirectChild(childState);
        this.callbacks.clearRecoveryTimers(childState);
        releaseSubscription?.();
        this.callbacks.releaseClientRetentionIfIdle();
        return true;
      };
      if (preserveCompletion()) {
        return;
      }
      const runtime = state.taskRuntime;
      // Earlier queued writes may bind or advance this original child's receipt.
      let expectedTask = childState.expectedTask ?? ownership.expectedTask;
      const completionCustody = ownership.completionCustody;
      if (runtime && !expectedTask) {
        throw new Error("Codex native subagent close has no admitted task assignment.");
      }
      const retireReplacedAssignment = async (assignment: AgentHarnessTaskAssignment) => {
        const read = await runtime!.prepareTaskRunRead!(childState.runId);
        if (!isCurrent()) {
          return true;
        }
        if (read().some((task) => matchesAgentHarnessTaskAssignment(task, assignment))) {
          return false;
        }
        // The exact writer refused a successor; only the obsolete delivery owner retires.
        this.callbacks.unregisterChild(childState);
        releaseSubscription?.();
        return true;
      };
      if (!childState.terminal) {
        const eventAt = this.callbacks.now();
        if (runtime) {
          if (!runtime.finalizeTaskRunByRunIdAsync) {
            throw new Error("Codex native subagent close requires asynchronous task finalization.");
          }
          const updated = await runtime.finalizeTaskRunByRunIdAsync({
            runId: childState.runId,
            expectedTask,
            completionCustody,
            status: "cancelled",
            endedAt: eventAt,
            lastEventAt: eventAt,
            error: summary,
            progressSummary: summary,
            terminalSummary: summary,
          });
          if (!isCurrent()) {
            return;
          }
          const previousTask = expectedTask;
          const committed = updated.find(
            (task) =>
              previousTask &&
              task.createdAt <= previousTask.createdAt &&
              matchesAgentHarnessTaskAssignment(
                { ...task, createdAt: previousTask.createdAt },
                previousTask,
              ),
          );
          // Advance a normalized lifecycle floor only from this exact transition's result.
          expectedTask = committed ? captureAgentHarnessTaskAssignment(committed) : undefined;
          if (
            !expectedTask ||
            !childState.expectedTask ||
            !matchesAgentHarnessTaskAssignment(childState.expectedTask, expectedTask)
          ) {
            if (previousTask && (await retireReplacedAssignment(previousTask))) {
              return;
            }
            throw new Error("Codex native subagent close finalization was not persisted.");
          }
          ownership.expectedTask = expectedTask;
        }
        childState.terminal = true;
        if (known?.parent === state && known.assignment.runId === childState.runId) {
          known.assignment.terminal = true;
          known.assignment.nativeTurnId = childState.nativeTurnId;
        }
        this.callbacks.markTerminalRevision(childState.childThreadId);
        state.mirror?.markAuthoritativeCompletion(childState.childThreadId, childState.runId);
      }
      if (preserveCompletion()) {
        return;
      }
      if (childState.pendingCompletion) {
        const completion = childState.pendingCompletion;
        if (runtime) {
          if (!runtime.setDetachedTaskDeliveryStatusByRunIdAsync) {
            throw new Error(
              "Codex native subagent close requires asynchronous delivery settlement.",
            );
          }
          const updated = await runtime.setDetachedTaskDeliveryStatusByRunIdAsync({
            runId: childState.runId,
            expectedTask,
            completionCustody,
            deliveryStatus: "failed",
            error: summary,
          });
          if (!isCurrent() || childState.pendingCompletion !== completion) {
            return;
          }
          const committedTask = expectedTask;
          if (
            !committedTask ||
            !updated.some((task) => matchesAgentHarnessTaskAssignment(task, committedTask))
          ) {
            if (committedTask && (await retireReplacedAssignment(committedTask))) {
              return;
            }
            throw new Error("Codex native subagent close delivery settlement was not persisted.");
          }
        }
        childState.pendingCompletion = undefined;
      }
      this.callbacks.unregisterChild(childState);
      releaseSubscription?.();
    };
    return state.mirror ? state.mirror.enqueuePersistence(settle) : settle();
  }

  retireReceiver(receiver: KnownChild, releaseSubscription: () => void): void {
    const threadId = receiver.assignment.childThreadId;
    if (
      this.callbacks.isParentRetired(receiver.parent) &&
      this.callbacks.knownChild(threadId) === receiver &&
      !this.callbacks.currentChild(threadId)
    ) {
      // Parent pruning has settled accepted writes and removed task owners.
      // The captured receiver must still own the subscription being released.
      releaseSubscription();
    }
  }

  private completeChildClose(state: ParentState, key: string, call: ChildCloseCall): Promise<void> {
    if (call.settlement) {
      return call.settlement;
    }
    const settlement = this.confirmChildClose(state, key, call);
    if (call.completing) {
      call.settlement = settlement;
    }
    return settlement;
  }

  private async confirmChildClose(
    state: ParentState,
    key: string,
    call: ChildCloseCall,
  ): Promise<void> {
    const isCurrent = () =>
      this.callbacks.isParentCurrent(state) && this.calls.get(state)?.get(key) === call;
    const isTargetCurrent = (target: ChildCloseCall["targets"][number]) => {
      const known = this.callbacks.knownChild(target.childThreadId);
      const childState = this.callbacks.currentChild(target.childThreadId);
      return (
        known?.parent === state &&
        known.assignment.runId === target.runId &&
        known.turnId === target.nativeTurnId &&
        known.pendingTurns.length === 0 &&
        (childState === undefined || childState === target.childState)
      );
    };
    const recordUnconfirmedClose = () => {
      const persist = async () => {
        if (!isCurrent()) {
          return;
        }
        for (const target of call.targets) {
          const known = this.callbacks.knownChild(target.childThreadId);
          const childState = this.callbacks.currentChild(target.childThreadId);
          if (
            !isTargetCurrent(target) ||
            known?.assignment.terminal ||
            childState?.terminal ||
            childState?.pendingCompletion
          ) {
            continue;
          }
          const runtime = state.taskRuntime;
          if (!runtime) {
            continue;
          }
          const expectedTask = childState?.expectedTask ?? target.expectedTask;
          const completionCustody = target.completionCustody;
          if (!expectedTask || !runtime.recordTaskRunProgressByRunIdAsync) {
            throw new Error(
              "Codex native subagent close requires its asynchronous task assignment.",
            );
          }
          const updated = await runtime.recordTaskRunProgressByRunIdAsync({
            runId: target.runId,
            expectedTask,
            completionCustody,
            lastEventAt: this.callbacks.now(),
            progressSummary: "Could not confirm that the subagent closed. Retry the close request.",
          });
          if (!isCurrent() || !isTargetCurrent(target)) {
            return;
          }
          const committed = updated.find(
            (task) =>
              task.createdAt <= expectedTask.createdAt &&
              matchesAgentHarnessTaskAssignment(
                { ...task, createdAt: expectedTask.createdAt },
                expectedTask,
              ),
          );
          if (!committed) {
            throw new Error("Codex native subagent close progress was not persisted.");
          }
          target.expectedTask = captureAgentHarnessTaskAssignment(committed);
        }
      };
      return state.mirror ? state.mirror.enqueuePersistence(persist) : persist();
    };
    if (
      call.completing ||
      !isCurrent() ||
      ![...state.owners.values()].some(
        (owner) => call.owners.has(owner) && owner.turnId === call.turnId,
      )
    ) {
      return;
    }
    // A matching native completion admits local confirmation. Ordinary parent
    // detachment lets it settle; explicit retirement still invalidates this call.
    call.completing = true;
    let settled = false;
    let persisting = false;
    try {
      const forgetters = await Promise.all(
        call.targets.map((target) => Promise.resolve(target.forget)),
      );
      if (!isCurrent()) {
        return;
      }
      // Collab status describes the child's previous state, even when close
      // fails. One complete runtime snapshot also covers Code Mode and ephemeral children.
      const loaded = await this.client.request("thread/loaded/list", {}, { timeoutMs: 10_000 });
      if (!isCurrent()) {
        return;
      }
      if (
        !isJsonObject(loaded) ||
        loaded.nextCursor !== null ||
        !Array.isArray(loaded.data) ||
        !loaded.data.every((id) => typeof id === "string" && id.trim() !== "")
      ) {
        persisting = true;
        await recordUnconfirmedClose();
        settled = true;
        return;
      }
      for (const [index, target] of call.targets.entries()) {
        const childState = this.callbacks.currentChild(target.childThreadId);
        if (loaded.data.includes(target.childThreadId) || !isTargetCurrent(target)) {
          continue;
        }
        // Native shutdown owns execution. A later ID-only unsubscribe could
        // stop a resumed runtime whose start notification has not arrived yet.
        const forget = forgetters[index];
        if (childState) {
          persisting = true;
          await this.retireChild(state, childState, "Subagent was closed.", forget, target);
          if (!isCurrent()) {
            return;
          }
        } else {
          forget?.();
        }
      }
      settled = true;
    } catch (error) {
      embeddedAgentLog.warn("Failed to confirm Codex native subagent close", {
        parentThreadId: state.parentThreadId,
        error: formatErrorMessage(error),
      });
      if (persisting) {
        throw error;
      }
      await recordUnconfirmedClose();
      settled = true;
    } finally {
      if (settled || !isCurrent()) {
        call.settled = true;
      } else {
        call.completing = undefined;
        call.settlement = undefined;
      }
      if (call.settled && this.calls.get(state)?.get(key) === call) {
        // Keep the call identity until its parent owner ends, so duplicate
        // starts cannot select a later assignment. Drop captured handles now.
        call.targets = [];
      }
      this.prune(state);
      this.callbacks.pruneParent(state);
    }
  }
}

export function isCodexNativeSubagentCloseNotification(
  notification: CodexServerNotification,
): boolean {
  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return false;
  }
  const params = isJsonObject(notification.params) ? notification.params : undefined;
  const item = isJsonObject(params?.item) ? params.item : undefined;
  return (
    readString(item, "type") === "collabAgentToolCall" &&
    normalizeIdentifier(readString(item, "tool")) === "closeagent"
  );
}
