import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeIdentifier } from "./native-subagent-history-recovery.js";
import type {
  ChildState,
  KnownChild,
  MonitorOptions,
  NativeSubagentMonitorClient,
  ParentOwner,
  ParentState,
} from "./native-subagent-monitor-types.js";
import { logRecoveryFailure } from "./native-subagent-recovery-coordinator.js";
import { readNativeSubagentThreadIds } from "./native-subagent-task-ids.js";
import { isJsonObject, type CodexServerNotification } from "./protocol.js";

type ChildCloseCall = {
  turnId: string;
  owners: Set<ParentOwner>;
  targets: Array<{
    childThreadId: string;
    runId: string;
    nativeTurnId?: string;
    childState?: ChildState;
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
        void this.completeChildClose(state, key, call);
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
        targets.push({
          childThreadId,
          runId: known.assignment.runId,
          nativeTurnId: known.turnId,
          childState: this.callbacks.currentChild(childThreadId),
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
  ): void {
    if (childState.pendingCompletion && !this.callbacks.isParentRetired(state)) {
      // Closing the native child does not discard its already accepted result.
      // Keep its delivery owner, but never warm the closed subscription later.
      childState.subscriptionClosed = true;
      this.callbacks.releaseDirectChild(childState);
      this.callbacks.clearRecoveryTimers(childState);
      releaseSubscription?.();
      this.callbacks.releaseClientRetentionIfIdle();
      return;
    }
    if (!childState.terminal) {
      childState.terminal = true;
      const known = this.callbacks.knownChild(childState.childThreadId);
      if (known?.assignment.runId === childState.runId) {
        known.assignment.terminal = true;
        known.assignment.nativeTurnId = childState.nativeTurnId;
      }
      this.callbacks.markTerminalRevision(childState.childThreadId);
      const eventAt = this.callbacks.now();
      state.mirror?.markAuthoritativeCompletion(childState.childThreadId);
      state.taskRuntime?.finalizeTaskRunByRunId({
        runId: childState.runId,
        status: "cancelled",
        endedAt: eventAt,
        lastEventAt: eventAt,
        error: summary,
        progressSummary: summary,
        terminalSummary: summary,
      });
    }
    if (childState.pendingCompletion) {
      childState.pendingCompletion = undefined;
      state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
        runId: childState.runId,
        deliveryStatus: "failed",
        error: summary,
      });
    }
    this.callbacks.unregisterChild(childState);
    releaseSubscription?.();
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
        state.taskRuntime?.recordTaskRunProgressByRunId({
          runId: target.runId,
          lastEventAt: this.callbacks.now(),
          progressSummary: "Could not confirm that the subagent closed. Retry the close request.",
        });
      }
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
        recordUnconfirmedClose();
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
          this.retireChild(state, childState, "Subagent was closed.", forget);
        } else {
          forget?.();
        }
      }
    } catch (error) {
      embeddedAgentLog.warn("Failed to confirm Codex native subagent close", {
        parentThreadId: state.parentThreadId,
        error: formatErrorMessage(error),
      });
      recordUnconfirmedClose();
    } finally {
      call.settled = true;
      if (this.calls.get(state)?.get(key) === call) {
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
