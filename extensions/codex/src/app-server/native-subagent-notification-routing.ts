import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  ChildState,
  DirectSpawnEvidence,
  ParentOwner,
  ParentState,
} from "./native-subagent-monitor-types.js";
import {
  normalizeIdentifier,
  readNativeSubagentThreadIds,
  readThreadParentThreadId,
  readThreadSpawnSource,
} from "./native-subagent-task-ids.js";
import { isJsonObject, type CodexServerNotification, type JsonObject } from "./protocol.js";

type NotificationRoutingDependencies = {
  resolveNativeParentState: (threadId: string) => ParentState | undefined;
  parentState: (threadId: string) => ParentState | undefined;
  currentChild: (threadId: string) => ChildState | undefined;
  resolveParentOwner: (
    state: ParentState,
    turnId: string | undefined,
    nativeParentThreadId: string,
  ) => ParentOwner | undefined;
  registerChildThread: (
    state: ParentState,
    childThreadId: string,
    options?: Pick<DirectSpawnEvidence, "agentPath" | "nativeParentThreadId"> & {
      onRegistered?: () => void;
    },
  ) => Promise<ChildState | undefined>;
  registerDirectSpawnChild: (
    state: ParentState,
    turnId: string | undefined,
    evidence: DirectSpawnEvidence,
    owner: ParentOwner | undefined,
    onRegistered?: () => void,
  ) => Promise<ChildState | undefined>;
  observeParentInteraction: (
    state: ParentState,
    owner: ParentOwner | undefined,
    childThreadId: string,
    agentPath: string | undefined,
    interaction: { parentTurnId?: string; itemId?: string; modelOwner?: ParentOwner },
  ) => Promise<void>;
  acceptInteraction: (
    state: ParentState,
    turnId: string | undefined,
    itemId: string | undefined,
    childThreadId: string,
    accept: (owner: ParentOwner) => void,
  ) => boolean;
  observeCall: (state: ParentState, turnId: string | undefined, item: JsonObject) => Promise<void>;
};

export function createCodexNativeSubagentNotificationRouter(
  deps: NotificationRoutingDependencies,
): (
  notification: CodexServerNotification,
  queueAdmission: (state: ParentState, childThreadId: string) => void,
) => Promise<ParentState | undefined> {
  return async (notification, queueAdmission) => {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return undefined;
    }
    if (notification.method === "thread/started") {
      const thread = isJsonObject(params.thread) ? params.thread : undefined;
      const parentThreadId = readThreadParentThreadId(thread);
      const childThreadId = thread ? readString(thread, "id")?.trim() : undefined;
      const agentPath = readString(readThreadSpawnSource(thread), "agent_path")?.trim();
      const state = parentThreadId ? deps.resolveNativeParentState(parentThreadId) : undefined;
      if (state?.preparing) {
        return undefined;
      }
      if (state && childThreadId && parentThreadId) {
        return (await deps.registerChildThread(state, childThreadId, {
          ...(agentPath === undefined ? {} : { agentPath }),
          nativeParentThreadId: parentThreadId,
          onRegistered: () => queueAdmission(state, childThreadId),
        }))
          ? state
          : undefined;
      }
      return state;
    }
    if (
      notification.method === "thread/status/changed" ||
      notification.method === "turn/started" ||
      notification.method === "turn/completed" ||
      notification.method === "item/agentMessage/delta"
    ) {
      const childThreadId = readString(params, "threadId")?.trim();
      const parentThreadId = childThreadId
        ? deps.currentChild(childThreadId)?.parentThreadId
        : undefined;
      return parentThreadId ? deps.parentState(parentThreadId) : undefined;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = isJsonObject(params.item) ? params.item : undefined;
      const parentThreadId = item
        ? (readString(item, "senderThreadId") ?? readString(params, "threadId"))?.trim()
        : undefined;
      const state = parentThreadId ? deps.resolveNativeParentState(parentThreadId) : undefined;
      if (state?.preparing) {
        return undefined;
      }
      if (state && parentThreadId) {
        const turnId = readString(params, "turnId");
        const owner = deps.resolveParentOwner(state, turnId, parentThreadId);
        if (notification.method === "item/completed") {
          if (
            readString(item, "type") === "subAgentActivity" &&
            readString(item, "kind") === "interacted"
          ) {
            const childThreadId = readString(item, "agentThreadId");
            if (childThreadId) {
              let preparation: Promise<void> | undefined;
              const accept = (admittedOwner: ParentOwner | undefined) => {
                preparation = deps.observeParentInteraction(
                  state,
                  owner,
                  childThreadId,
                  readString(item, "agentPath"),
                  {
                    parentTurnId: turnId,
                    itemId: readString(item, "id"),
                    modelOwner: admittedOwner,
                  },
                );
              };
              if (
                !deps.acceptInteraction(
                  state,
                  turnId,
                  readString(item, "id"),
                  childThreadId,
                  accept,
                )
              ) {
                accept(owner);
              }
              await preparation;
            }
            return state;
          }
          if (
            readString(item, "type") === "collabAgentToolCall" &&
            readString(item, "tool") === "sendInput" &&
            readString(item, "status") === "completed"
          ) {
            await deps.observeCall(state, turnId, item!);
            return undefined;
          }
        }
        // Codex multi-agent V2 exposes the child only through this parent-scoped
        // activity item; its later wait item has no receiver thread ids.
        if (
          notification.method === "item/completed" &&
          readString(item, "type") === "subAgentActivity" &&
          normalizeIdentifier(readString(item, "kind")) === "started"
        ) {
          const childThreadId = readString(item, "agentThreadId")?.trim();
          const agentPath = readString(item, "agentPath");
          if (childThreadId) {
            await deps.registerDirectSpawnChild(
              state,
              turnId,
              {
                parentThreadId: state.parentThreadId,
                nativeParentThreadId: parentThreadId,
                childThreadId,
                ...(agentPath === undefined ? {} : { agentPath }),
              },
              owner,
              () => queueAdmission(state, childThreadId),
            );
          }
          return state;
        }
        const isCompletedSpawnAgentTool =
          notification.method === "item/completed" &&
          readString(item, "type") === "collabAgentToolCall" &&
          normalizeIdentifier(readString(item, "tool")) === "spawnagent" &&
          normalizeIdentifier(readString(item, "status")) === "completed";
        if (normalizeIdentifier(readString(item, "tool")) === "closeagent") {
          // closeAgent names an existing child before shutdown; treating its
          // receiver as discovery resurrects completed tasks and repins parents.
          return state;
        }
        if (parentThreadId !== state.parentThreadId && !isCompletedSpawnAgentTool) {
          // Nested waits observe receivers; only accepted spawn/input paths claim them.
          return state;
        }
        // Pinned Codex derives both fields from the spawn ID, but agentsStates is
        // observational status metadata. Only receiverThreadIds is authoritative
        // direct-spawn evidence and may mint retained child authority.
        const childThreadIds = new Set(readNativeSubagentThreadIds(item?.receiverThreadIds));
        const pending = [...childThreadIds].map((childThreadId) =>
          isCompletedSpawnAgentTool
            ? deps.registerDirectSpawnChild(
                state,
                turnId,
                {
                  parentThreadId: state.parentThreadId,
                  nativeParentThreadId: parentThreadId,
                  childThreadId,
                },
                owner,
                () => queueAdmission(state, childThreadId),
              )
            : deps.registerChildThread(state, childThreadId, {
                onRegistered: () => queueAdmission(state, childThreadId),
              }),
        );
        if (!(await Promise.all(pending)).every(Boolean)) {
          return undefined;
        }
      }
      return state;
    }
    return undefined;
  };
}
