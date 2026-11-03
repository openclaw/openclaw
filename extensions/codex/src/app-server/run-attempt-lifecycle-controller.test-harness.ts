import { setImmediate as yieldImmediate } from "node:timers/promises";
import { vi } from "vitest";
import { interruptCodexTurnAndWaitBestEffort } from "./attempt-client-cleanup.js";
import { createCodexSteeringQueue } from "./attempt-steering.js";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import type { buildEmptyToolTelemetry, createProjector } from "./event-projector.test-harness.js";
import { prepareCodexServerNotification } from "./protocol-validators.js";
import type { JsonObject, CodexServerNotification } from "./protocol.js";
import { createCodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { createCodexAttemptNotificationController } from "./run-attempt-notification-controller.js";

export const scope = { threadId: "thread-1", turnId: "turn-1" };
export const rawCall = (callId: string, name = callId, namespace?: string) => ({
  type: "function_call",
  call_id: callId,
  name,
  arguments: "{}",
  ...(namespace ? { namespace } : {}),
});

export function createTerminalReleaseHarness(options?: {
  projector?: Awaited<ReturnType<typeof createProjector>>;
  telemetry?: ReturnType<typeof buildEmptyToolTelemetry>;
}) {
  const order: string[] = [];
  const notificationHandlers = new Set<(notification: unknown) => void>();

  const request = vi.fn(async (method: string) => {
    order.push(method);
    return {};
  });
  const sourceReplies: NonNullable<CodexDynamicToolRuntimeResponse["toolAuthoredSourceReply"]>[] =
    [];
  const state = {
    completed: false,
    activeAppServerTurnRequests: 0,
    activeLocalProjections: 0,
    currentTurnHadNonTerminalDynamicToolResult: false,
    pendingTerminalDynamicToolRelease: undefined,
    terminalDynamicToolReleaseCheckScheduled: false,
    resolveCompletion: vi.fn(),
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
  const steeringQueue = createCodexSteeringQueue({
    client: client as never,
    ...scope,
    requestTimeoutMs: 60_000,
    signal: new AbortController().signal,
    assertActive: () => {},
    prepareMessage: async (text) => ({
      input: [{ type: "text", text, text_elements: [] }],
      message: { role: "user", content: text, timestamp: 1 },
    }),
  });
  const cancel = vi.fn(() => {
    order.push("cancel");
    steeringQueue.cancel();
  });
  const sealAdmission = vi.fn(() => steeringQueue.sealAdmission());
  const drainBeforeCancel = vi.fn(() => {
    const drain = steeringQueue.drainBeforeCancel();
    if (drain) {
      return drain.then(() => cancel());
    }
    cancel();
    return undefined;
  });
  const resources = {
    prompt: {
      turnState: { codexTurnPromptText: "test" },
      context: {
        attemptTools: {
          toolBridge: {
            telemetry: options?.telemetry ?? { messagingToolSourceReplyPayloads: sourceReplies },
          },
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
      current: options?.projector ?? {
        handleNotification: vi.fn(async () => {}),
        recordMcpToolCallReceipt: vi.fn(),
      },
    },
  };
  const turnRuntime = {
    state,
    turnIdRef: { current: "turn-1" },
    noteProgress: vi.fn(),
    deadlines: { beginSettlement: vi.fn() },
    activeTurnItemIds,
    pendingOpenClawDynamicToolCompletionIds,
    steeringQueueRef: { current: { ...steeringQueue, cancel, sealAdmission, drainBeforeCancel } },
    interruptTurn: (turnId: string) =>
      interruptCodexTurnAndWaitBestEffort(client as never, {
        threadId: "thread-1",
        turnId,
      }),
    completeTurn: () => {
      state.completed = true;
      state.resolveCompletion();
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
    const prepared = prepareCodexServerNotification(notification, scope);
    notifications.noteNotificationReceived(prepared, scope, 0);
    await notifications.enqueueNotification(prepared);
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
  const notifyRawItem = (item: JsonObject) =>
    notify({ method: "rawResponseItem/completed", params: { ...scope, item } });
  const notifyRawCall = (callId: string, name = callId) => notifyRawItem(rawCall(callId, name));
  const finishResponse = () =>
    notify({
      method: "rawResponse/completed",
      params: { ...scope, responseId: `response-${++responseIndex}` },
    });
  return {
    async [Symbol.asyncDispose]() {
      completeTurn();
      await yieldImmediate();
    },
    activeTurnItemIds,
    steeringQueue,
    sealAdmission,
    cancel,
    sourceReplies,
    completeTurn,
    controller,
    receive: (notification: CodexServerNotification) =>
      notifications.noteNotificationReceived(
        prepareCodexServerNotification(notification),
        scope,
        0,
      ),
    observeResponse: async (callIds: string[]) => {
      for (const callId of callIds) {
        await notifyRawCall(callId);
      }
      await finishResponse();
    },
    notify,
    notifyRawItem,
    notifyRawCall,
    finishResponse,
    notifyNativeItem: (
      method: "item/started" | "item/completed",
      status: string,
      exitCode?: number,
    ) =>
      notifications.enqueueNotification(
        prepareCodexServerNotification({
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
        }),
      ),
    order,
    pendingOpenClawDynamicToolCompletionIds,
    request,
    resolveCompletion: state.resolveCompletion,
    state,
  };
}

export const terminalYieldResult = (success: boolean) => ({
  ...dynamicToolResult("call-yield", { success, terminate: true }),
  call: { ...scope, callId: "call-yield", tool: "sessions_yield", arguments: {} },
});

export function dynamicToolResult(
  callId: string,
  response: Pick<
    CodexDynamicToolRuntimeResponse,
    | "success"
    | "terminate"
    | "toolAuthoredSourceReply"
    | "asyncStarted"
    | "finalSourceReplyDelivered"
  >,
) {
  return {
    call: { ...scope, callId, tool: callId, arguments: {} },
    response: { contentItems: [], ...response },
    durationMs: 1,
  };
}
