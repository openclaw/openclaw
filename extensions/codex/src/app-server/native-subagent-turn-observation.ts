import { randomUUID } from "node:crypto";
import { emitAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { projectNormalizedToolItem } from "./event-projector-events.js";
import { readItem } from "./event-projector-values.js";
import { readNativeTurnEnd } from "./native-subagent-history-recovery.js";
import type { ChildState, NativeExecutionWait } from "./native-subagent-monitor-types.js";
import {
  codexNativeSubagentRunId,
  normalizeIdentifier,
  readCodexNativeSubagentRunId,
  readNativeSubagentThreadIds,
} from "./native-subagent-task-ids.js";
import type { CodexServerNotification } from "./protocol.js";
import { isJsonObject } from "./protocol.js";

type NativeSubagentTurnObservationCallbacks = {
  emitTaskEvent: (
    child: ChildState,
    event: Pick<Parameters<typeof emitAgentEvent>[0], "stream" | "data">,
  ) => void;
  currentChild: (threadId: string) => ChildState | undefined;
  dependencyRunId: (parentThreadId: string, childThreadId: string) => string | undefined;
  onTurnEnded: (childState: ChildState) => ChildState | undefined;
};

export class CodexNativeSubagentTurnObservation {
  private readonly observationSourceId = randomUUID();
  private readonly projectedActivityWaits = new WeakSet<ChildState>();

  constructor(private readonly callbacks: NativeSubagentTurnObservationCallbacks) {}

  invalidate(childState: ChildState): void {
    this.projectedActivityWaits.delete(childState);
    if (!childState.terminal && childState.activityObserved) {
      this.callbacks.emitTaskEvent(childState, {
        stream: "execution",
        data: { state: "unknown", sourceId: this.observationSourceId, invalidate: true },
      });
    }
  }

  markActivityUnknown(childState: ChildState): void {
    this.projectedActivityWaits.delete(childState);
    childState.activityObserved = true;
    this.callbacks.emitTaskEvent(childState, {
      stream: "execution",
      data: {
        state: "unknown",
        sourceId: this.observationSourceId,
        executionId: childState.nativeTurnId,
      },
    });
  }

  refreshWaitDependency(childState: ChildState, receiverThreadId: string): void {
    const activityWait = childState.activityWait;
    if (
      childState.terminal ||
      (childState.nativeTurnState && childState.nativeTurnState !== "active") ||
      this.callbacks.currentChild(childState.childThreadId) !== childState ||
      activityWait?.wait.kind !== "children"
    ) {
      return;
    }
    const runId = this.callbacks.dependencyRunId(childState.parentThreadId, receiverThreadId);
    if (!runId) {
      return;
    }
    let changed = false;
    const dependencies = activityWait.wait.dependencies?.map((dependency) => {
      if (
        dependency.runId === runId ||
        readCodexNativeSubagentRunId(dependency.runId)?.threadId !== receiverThreadId
      ) {
        return dependency;
      }
      changed = true;
      return { runId };
    });
    if (!changed) {
      return;
    }
    const wait = { ...activityWait.wait, dependencies };
    childState.activityWait = { ...activityWait, wait };
    // Attention flags can temporarily overlay a native wait without ending it.
    if (this.projectedActivityWaits.has(childState)) {
      this.observeActivity(childState, "waiting", wait);
    }
  }

  private observeActivity(
    childState: ChildState,
    state: "running" | "waiting" | "unknown",
    wait?: NativeExecutionWait,
  ): void {
    if (wait && wait === childState.activityWait?.wait) {
      this.projectedActivityWaits.add(childState);
    } else {
      this.projectedActivityWaits.delete(childState);
    }
    childState.activityObserved = true;
    this.callbacks.emitTaskEvent(childState, {
      stream: "execution",
      data: {
        state,
        sourceId: this.observationSourceId,
        ...(childState.nativeTurnId ? { executionId: childState.nativeTurnId } : {}),
        ...(wait ? { wait } : {}),
      },
    });
  }

  private emitActivityEvent(
    child: ChildState,
    event: Parameters<NativeSubagentTurnObservationCallbacks["emitTaskEvent"]>[1],
  ): void {
    if (!child.activityObserved) {
      this.observeActivity(child, "running");
    }
    this.callbacks.emitTaskEvent(child, event);
  }

  emitChildTaskActivity(notification: CodexServerNotification, childState: ChildState): void {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return;
    }
    const turn = isJsonObject(params.turn) ? params.turn : undefined;
    const turnId = readString(params, "turnId") ?? readString(turn, "id");
    if (notification.method === "turn/started") {
      childState.nativeTurnId = turnId;
      childState.nativeTurnState = "active";
      childState.activityWait = undefined;
    } else if (turnId && childState.nativeTurnId && turnId !== childState.nativeTurnId) {
      return;
    } else if (turnId && childState.nativeTurnState && childState.nativeTurnState !== "active") {
      return;
    } else if (turnId) {
      childState.nativeTurnId ??= turnId;
    }
    const observe = (state: "running" | "waiting" | "unknown", wait?: NativeExecutionWait) =>
      this.observeActivity(childState, state, wait);
    if (notification.method === "turn/started") {
      observe("running");
      return;
    }
    if (notification.method === "turn/completed") {
      childState.nativeTurnState = readNativeTurnEnd(turn);
      childState.activityWait = undefined;
      // Ending a native turn does not settle its task. The completion owner
      // still resolves the result, and interrupted children can receive input.
      observe("unknown");
      const current = this.callbacks.onTurnEnded(childState);
      if (current?.nativeTurnId !== turnId && current?.nativeTurnState === "active") {
        this.emitChildTaskActivity(
          {
            method: "turn/started",
            params: { threadId: current.childThreadId, turn: { id: current.nativeTurnId! } },
          },
          current,
        );
      }
      return;
    }
    if (notification.method === "thread/status/changed") {
      const status = isJsonObject(params.status) ? params.status : undefined;
      if (status?.type === "active") {
        const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
        const wait: NativeExecutionWait | undefined = flags.includes("waitingOnApproval")
          ? { kind: "approval" }
          : flags.includes("waitingOnUserInput")
            ? { kind: "user_input" }
            : childState.activityWait?.wait;
        observe(wait ? "waiting" : "running", wait);
      } else if (
        status?.type === "idle" ||
        status?.type === "notLoaded" ||
        status?.type === "systemError"
      ) {
        childState.activityWait = undefined;
        observe("unknown");
      }
      return;
    }
    if (
      notification.method === "item/agentMessage/delta" ||
      notification.method === "item/reasoning/summaryTextDelta"
    ) {
      const delta = readString(params, "delta");
      if (delta) {
        this.emitActivityEvent(childState, {
          stream: notification.method === "item/agentMessage/delta" ? "assistant" : "thinking",
          data: { delta },
        });
      }
      return;
    }
    if (notification.method !== "item/started" && notification.method !== "item/completed") {
      return;
    }
    const item = readItem(params.item);
    if (
      item?.type === "collabAgentToolCall" &&
      normalizeIdentifier(item.tool ?? undefined) === "wait" &&
      Array.isArray(item.receiverThreadIds)
    ) {
      if (notification.method === "item/started") {
        const receivers = [
          ...new Set(readNativeSubagentThreadIds(item.receiverThreadIds).map((id) => id.trim())),
        ];
        // V2 has no target IDs; V1 exposes its selected children explicitly.
        const wait: NativeExecutionWait =
          receivers.length > 0
            ? {
                kind: "children",
                dependencies: receivers.slice(0, 32).map((id) => ({
                  runId:
                    this.callbacks.dependencyRunId(childState.parentThreadId, id) ??
                    codexNativeSubagentRunId(id),
                })),
                pendingCount: receivers.length,
              }
            : { kind: "agent_messages" };
        childState.activityWait = { itemId: item.id, wait };
        observe("waiting", wait);
      } else if (childState.activityWait?.itemId === item.id) {
        childState.activityWait = undefined;
        observe("running");
      }
      return;
    }
    if (item?.type === "agentMessage" && notification.method === "item/completed" && item.text) {
      this.emitActivityEvent(childState, { stream: "assistant", data: { text: item.text } });
    }
    const projection = projectNormalizedToolItem({
      phase: notification.method === "item/started" ? "start" : "result",
      item,
    });
    if (projection?.event) {
      this.emitActivityEvent(childState, projection.event);
    }
  }
}
