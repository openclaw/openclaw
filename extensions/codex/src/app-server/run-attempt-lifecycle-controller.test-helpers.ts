import { vi } from "vitest";
import { interruptCodexTurnAndWaitBestEffort } from "./attempt-client-cleanup.js";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import type { JsonObject, CodexServerNotification } from "./protocol.js";
import { createCodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { createCodexAttemptNotificationController } from "./run-attempt-notification-controller.js";

export function createTerminalReleaseHarness() {
  const order: string[] = [];
  const notificationHandlers = new Set<(notification: unknown) => void>();
  const cancel = vi.fn(() => order.push("cancel"));
  const sealAdmission = vi.fn();
  const request = vi.fn(async (method: string) => {
    order.push(method);
    return {};
  });
  const resolveCompletion = vi.fn();
  const sourceReplies: NonNullable<CodexDynamicToolRuntimeResponse["toolAuthoredSourceReply"]>[] =
    [];
  const state = {
    completed: false,
    activeAppServerTurnRequests: 0,
    activeLocalProjections: 0,
    currentTurnHadNonTerminalDynamicToolResult: false,
    pendingTerminalDynamicToolRelease: undefined,
    terminalDynamicToolReleaseCheckScheduled: false,
    resolveCompletion,
  };
  const pendingOpenClawDynamicToolCompletionIds = new Set<string>();
  const activeTurnItemIds = new Set<string>();
  const client = {
    request,
    addNotificationHandler: (handler: (notification: unknown) => void) => {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    addRequestHandler: () => () => undefined,
    addCloseHandler: () => () => undefined,
  };
  const resources = {
    prompt: {
      turnState: { codexTurnPromptText: "test" },
      context: {
        attemptTools: {
          toolBridge: { telemetry: { messagingToolSourceReplyPayloads: sourceReplies } },
        },
        runtime: {
          connection: {
            params: {},
            attemptStartedAt: 0,
            runAbortController: new AbortController(),
            fastModeAutoProgressState: {},
          },
        },
      },
    },
    state: { client, thread: { threadId: "thread-1" } },
    projectorRef: {
      current: { handleNotification: vi.fn(async () => {}), recordMcpToolCallReceipt: vi.fn() },
    },
  };
  const turnRuntime = {
    state,
    turnIdRef: { current: "turn-1" },
    noteProgress: vi.fn(),
    activeTurnItemIds,
    pendingOpenClawDynamicToolCompletionIds,
    steeringQueueRef: {
      current: {
        cancel,
        sealAdmission,
        drainBeforeCancel: () => void cancel(),
      },
    },
    interruptTurn: (turnId: string) =>
      interruptCodexTurnAndWaitBestEffort(client as never, {
        threadId: "thread-1",
        turnId,
      }),
    completeTurn: () => {
      state.completed = true;
      resolveCompletion();
    },
  };
  const controller = createCodexAttemptLifecycleController(
    resources as never,
    turnRuntime as never,
  );
  const notifications = createCodexAttemptNotificationController(
    resources as never,
    turnRuntime as never,
    controller,
  );
  let responseIndex = 0;
  const notify = async (notification: CodexServerNotification) => {
    const scope = { threadId: "thread-1", turnId: "turn-1" };
    notifications.noteNotificationReceived(notification, scope, 0);
    await notifications.enqueueNotification(notification, scope);
  };
  const completeTurn = () => {
    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "interrupted", items: [] },
        },
      });
    }
  };
  return {
    activeTurnItemIds,
    sealAdmission,
    cancel,
    sourceReplies,
    completeTurn,
    controller,
    receive: (notification: CodexServerNotification) =>
      notifications.noteNotificationReceived(
        notification,
        { threadId: "thread-1", turnId: "turn-1" },
        0,
      ),
    observeResponse: async (callIds: string[]) => {
      for (const callId of callIds) {
        await notify({
          method: "rawResponseItem/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { type: "function_call", call_id: callId, name: callId, arguments: "{}" },
          },
        });
      }
      await notify({
        method: "rawResponse/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          responseId: `response-${++responseIndex}`,
        },
      });
    },
    notifyRawItem: (item: JsonObject) =>
      notify({
        method: "rawResponseItem/completed",
        params: { threadId: "thread-1", turnId: "turn-1", item },
      }),
    notifyRawCall: (callId: string, name = callId) =>
      notify({
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "function_call", call_id: callId, name, arguments: "{}" },
        },
      }),
    finishResponse: () =>
      notify({
        method: "rawResponse/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          responseId: `response-${++responseIndex}`,
        },
      }),
    notifyNativeItem: (
      method: "item/started" | "item/completed",
      status: string,
      exitCode?: number,
    ) =>
      notifications.enqueueNotification(
        {
          method,
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "native",
              type: "commandExecution",
              status,
              ...(exitCode !== undefined ? { exitCode } : {}),
            },
          },
        },
        { threadId: "thread-1", turnId: "turn-1" },
      ),
    order,
    pendingOpenClawDynamicToolCompletionIds,
    request,
    resolveCompletion,
    state,
  };
}
