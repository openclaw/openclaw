import { setImmediate as yieldImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { interruptCodexTurnAndWaitBestEffort } from "./attempt-client-cleanup.js";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import { prepareCodexServerNotification } from "./protocol-validators.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type JsonObject,
  type CodexServerNotification,
} from "./protocol.js";
import { createCodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { buildCodexLifecycleTerminalMeta } from "./run-attempt-lifecycle-terminal.js";
import { createCodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import { createCodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { createClientHarness } from "./test-support.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";

function expectUnreleased(h: ReturnType<typeof createTerminalReleaseHarness>) {
  expect(h.state.completed).toBe(false);
  expect(h.cancel).not.toHaveBeenCalled();
  expect(h.sourceReplies).toEqual([]);
}

const finalReply = (text: string) => ({
  text,
  toolAuthored: true as const,
  sourceReplyFinal: true,
});
const scope = { threadId: "thread-1", turnId: "turn-1" };
const rawCall = (callId: string, name = callId, namespace?: string) => ({
  type: "function_call",
  call_id: callId,
  name,
  arguments: "{}",
  ...(namespace ? { namespace } : {}),
});

function createTerminalReleaseHarness() {
  const order: string[] = [];
  const notificationHandlers = new Set<(notification: unknown) => void>();
  const cancel = vi.fn(() => {
    order.push("cancel");
  });
  const sealAdmission = vi.fn();
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
    steeringQueueRef: { current: { cancel, sealAdmission, drainBeforeCancel: cancel } },
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
    cancel,
    sealAdmission,
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

const terminalYieldResult = (success: boolean) => ({
  ...dynamicToolResult("call-yield", { success, terminate: true }),
  call: { ...scope, callId: "call-yield", tool: "sessions_yield", arguments: {} },
});

describe("buildCodexLifecycleTerminalMeta", () => {
  it("marks sessions_yield as a paused parent continuation", () => {
    expect(
      buildCodexLifecycleTerminalMeta({ aborted: false, timedOut: false, yielded: true }),
    ).toEqual({
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
    });
  });

  it("keeps ordinary successful turns terminal", () => {
    expect(
      buildCodexLifecycleTerminalMeta({
        aborted: false,
        timedOut: false,
        yielded: false,
      }),
    ).toBeUndefined();
  });

  it("keeps cancellation stronger than a stale yield signal", () => {
    expect(
      buildCodexLifecycleTerminalMeta({
        aborted: true,
        timedOut: false,
        yielded: true,
      }),
    ).toEqual({
      aborted: true,
      status: "cancelled",
      stopReason: "stop",
    });
  });
});

describe("Codex terminal dynamic-tool release", () => {
  it("keeps native yield cleanup alive after its subscription route is released", async () => {
    const physical = createClientHarness({
      onWrite: (line, send) => {
        const request = JSON.parse(line) as { id: number; method: string };
        if (request.method === "turn/interrupt") {
          send({ id: request.id, result: {} });
        }
      },
    });
    const completeNative = (threadId: string, id: string, status: string) =>
      physical.send({
        method: "turn/completed",
        params: { threadId, turn: { id, status, items: [] } },
      });
    const router = getCodexAppServerTurnRouter(physical.client);
    const route = router.reserveThread({ threadId: "thread-1", onNotification: vi.fn() });
    const peerRoute = router.reserveThread({ threadId: "thread-peer", onNotification: vi.fn() });
    const resources = {
      prompt: {
        context: {
          runtime: {
            connection: {
              params: { timeoutMs: 60_000 },
              options: {},
              attemptStartedAt: Date.now(),
              attemptStartedAtMonotonicMs: performance.now(),
              runAbortController: new AbortController(),
              fastModeAutoProgressState: {},
            },
          },
        },
      },
      state: { client: physical.client, thread: { threadId: "thread-1" }, turnRoute: route },
      projectorRef: {},
      startupTimeoutMs: 1_000,
    };
    const runtime = createCodexAttemptTurnState(resources as never);
    runtime.steeringQueueRef.current = {
      cancel: vi.fn(),
      sealAdmission: vi.fn(),
      drainBeforeCancel: vi.fn(),
    } as never;
    const interrupt = vi.spyOn(runtime, "interruptTurn");
    const controller = createCodexAttemptLifecycleController(resources as never, runtime);
    try {
      route.armTurn();
      await route.bindTurn("turn-1");
      controller.recordDynamicToolResult(terminalYieldResult(true));
      await runtime.completion;
      expect(runtime.state.completed).toBe(true);
      expect(interrupt).toHaveBeenCalledOnce();
      const nativeCleanup = interrupt.mock.results[0]?.value;
      const settled = vi.fn();
      void runtime.state.abortCleanup.then(settled, settled);

      route.release();
      await yieldImmediate();
      expect(settled).not.toHaveBeenCalled();
      expect(physical.stdinDestroyed).toBe(false);
      expect(peerRoute.signal.aborted).toBe(false);
      completeNative("thread-peer", "peer-turn", "completed");
      completeNative("thread-1", "previous-turn", "interrupted");
      await yieldImmediate();
      expect(settled).not.toHaveBeenCalled();
      expect(runtime.state.nativeCancellationConfirmed).toBe(false);
      completeNative("thread-1", "turn-1", "interrupted");
      await expect(nativeCleanup).resolves.toBe(true);
      await runtime.state.abortCleanup;
      expect(settled).toHaveBeenCalledOnce();
      expect(runtime.state.nativeCancellationConfirmed).toBe(true);
      expect(physical.stdinDestroyed).toBe(false);
      expect(peerRoute.signal.aborted).toBe(false);
    } finally {
      runtime.deadlines.dispose();
      physical.client.close();
    }
  });

  it("completes a successful yield before native interrupt completion", async () => {
    const harness = createTerminalReleaseHarness();
    // The RPC receives a remaining budget; keep this exact-value assertion on one clock tick.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    // The deadline now reads performance.now(); alias it to the mocked wall clock so
    // the exact-value timeoutMs assertion stays on a single tick.
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(1_000);
    try {
      harness.controller.recordDynamicToolResult(terminalYieldResult(true));
      await yieldImmediate();

      expect(harness.cancel).toHaveBeenCalled();
      expect(harness.request).toHaveBeenCalledWith(
        "turn/interrupt",
        { threadId: "thread-1", turnId: "turn-1" },
        expect.objectContaining({ timeoutMs: 5_000 }),
      );
      expect(harness.order.indexOf("cancel")).toBeLessThan(harness.order.indexOf("turn/interrupt"));
      expect(harness.state.completed).toBe(true);
      expect(harness.resolveCompletion).toHaveBeenCalledOnce();

      harness.completeTurn();
      harness.controller.recordDynamicToolResult(terminalYieldResult(true));
      await yieldImmediate();

      expect(harness.request).toHaveBeenCalledOnce();
      expect(harness.resolveCompletion).toHaveBeenCalledOnce();
    } finally {
      harness.completeTurn();
      await yieldImmediate();
      monotonic.mockRestore();
      clock.mockRestore();
    }
  });

  it.each(["request", "native-item", "tool-response"] as const)(
    "waits for a pending %s before releasing a terminal tool batch",
    async (pending) => {
      vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
      const harness = createTerminalReleaseHarness();
      harness.state.activeAppServerTurnRequests = pending === "request" ? 1 : 0;
      if (pending === "native-item") {
        harness.activeTurnItemIds.add("native-item");
      } else if (pending === "tool-response") {
        harness.pendingOpenClawDynamicToolCompletionIds.add("tool-response");
      }
      try {
        harness.controller.recordDynamicToolResult(terminalYieldResult(true));
        await vi.runOnlyPendingTimersAsync();
        expect(harness.request).not.toHaveBeenCalled();
        expect(harness.state.completed).toBe(false);
        // Native activity delays interruption, but the accepted terminal response
        // already fenced steering once its own response and siblings settled.
        expect(harness.sealAdmission).toHaveBeenCalledTimes(pending === "native-item" ? 1 : 0);
        expect(harness.cancel).not.toHaveBeenCalled();

        harness.state.activeAppServerTurnRequests = 0;
        harness.activeTurnItemIds.clear();
        harness.pendingOpenClawDynamicToolCompletionIds.clear();
        harness.controller.scheduleTerminalDynamicToolReleaseCheck();
        await vi.runOnlyPendingTimersAsync();
        expect(harness.request).toHaveBeenCalledOnce();
        expect(harness.state.completed).toBe(true);
        expect(harness.resolveCompletion).toHaveBeenCalledOnce();
      } finally {
        harness.completeTurn();
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
      }
    },
  );

  it.each(["reply", "sibling"] as const)(
    "completes a delivered final reply after a failed sibling when %s settles first",
    async (first) => {
      await using harness = createTerminalReleaseHarness();
      await harness.observeResponse(["reply", "sibling"]);
      harness.pendingOpenClawDynamicToolCompletionIds.add("reply");
      harness.pendingOpenClawDynamicToolCompletionIds.add("sibling");
      const results = {
        reply: dynamicToolResult("reply", {
          success: false,
          terminate: true,
          finalSourceReplyDelivered: true,
        }),
        sibling: dynamicToolResult("sibling", { success: false }),
      };
      for (const name of [first, first === "reply" ? "sibling" : "reply"] as const) {
        harness.pendingOpenClawDynamicToolCompletionIds.delete(name);
        harness.controller.recordDynamicToolResult(results[name]);
        harness.controller.scheduleTerminalDynamicToolReleaseCheck();
        await yieldImmediate();
        expect(harness.state.completed).toBe(
          harness.pendingOpenClawDynamicToolCompletionIds.size === 0,
        );
      }
      expect(harness.request).toHaveBeenCalledWith(
        "turn/interrupt",
        { threadId: "thread-1", turnId: "turn-1" },
        expect.anything(),
      );
      expect(harness.resolveCompletion).toHaveBeenCalledOnce();
      expect(harness.sourceReplies).toEqual([]);
    },
  );

  it("keeps steering open when the yield result fails", async () => {
    const harness = createTerminalReleaseHarness();

    harness.controller.recordDynamicToolResult(terminalYieldResult(false));
    harness.controller.scheduleTerminalDynamicToolReleaseCheck();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(harness.cancel).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.state.completed).toBe(false);
    expect(harness.resolveCompletion).not.toHaveBeenCalled();
  });
});

function dynamicToolResult(
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

const authored = (callId: string) =>
  dynamicToolResult(callId, {
    success: true,
    terminate: true,
    toolAuthoredSourceReply: finalReply(callId),
  });

// One Codex model step ran a capable tool and an ordinary tool together. Each result
// settles the way the server-request handler settles it: the call leaves the pending
// set, the result is classified, and a release check runs once the request ends.
async function settleBatch(
  order: Array<"reply" | "note">,
  reply: { toolAuthored: boolean; siblingSuccess?: boolean; siblingAsync?: boolean },
) {
  const harness = createTerminalReleaseHarness();
  const results = {
    reply: dynamicToolResult("call-reply", {
      success: true,
      terminate: true,
      ...(reply.toolAuthored
        ? {
            toolAuthoredSourceReply: finalReply("Order created."),
          }
        : {}),
    }),
    note: dynamicToolResult("call-note", {
      success: reply.siblingSuccess ?? true,
      asyncStarted: reply.siblingAsync,
    }),
  };
  await harness.observeResponse(["call-reply", "call-note"]);
  harness.pendingOpenClawDynamicToolCompletionIds.add("call-reply");
  harness.pendingOpenClawDynamicToolCompletionIds.add("call-note");
  const releasedAfter: string[] = [];
  for (const name of order) {
    harness.pendingOpenClawDynamicToolCompletionIds.delete(results[name].call.callId);
    harness.controller.recordDynamicToolResult(results[name] as never);
    harness.controller.scheduleTerminalDynamicToolReleaseCheck();
    await yieldImmediate();
    releasedAfter.push(`${name}:${harness.state.completed ? "released" : "open"}`);
  }
  return { harness, releasedAfter };
}

describe("Codex batch release after a tool-authored final reply", () => {
  it.each([
    { first: "reply", status: "failed", exitCode: 1 },
    { first: "native", status: "failed", exitCode: 1 },
    { first: "reply", status: "completed", exitCode: 0 },
    { first: "native", status: "completed", exitCode: 0 },
  ])(
    "continues after an unhandled native $status sibling when $first completes first",
    async ({ first, status, exitCode }) => {
      const harness = createTerminalReleaseHarness();
      await harness.observeResponse(["native", "reply"]);
      harness.pendingOpenClawDynamicToolCompletionIds.add("reply");
      await harness.notifyNativeItem("item/started", "inProgress");
      const completeReply = () => {
        harness.pendingOpenClawDynamicToolCompletionIds.delete("reply");
        harness.controller.recordDynamicToolResult(
          dynamicToolResult("reply", {
            success: true,
            terminate: true,
            toolAuthoredSourceReply: finalReply("Premature reply."),
          }),
        );
      };
      if (first === "reply") {
        completeReply();
        await yieldImmediate();
      }
      await harness.notifyNativeItem("item/completed", status, exitCode);
      await yieldImmediate();
      if (first === "native") {
        completeReply();
        await yieldImmediate();
      }
      expect(harness.state.completed).toBe(false);
      expect(harness.request).not.toHaveBeenCalled();
      expect(harness.sourceReplies).toEqual([]);
      // The nonterminal batch has now settled. A later model step may finish
      // normally; native work in an earlier batch is not a turn-wide veto.
      try {
        await harness.observeResponse(["later"]);
        harness.controller.recordDynamicToolResult(
          dynamicToolResult("later", {
            success: true,
            terminate: true,
            toolAuthoredSourceReply: finalReply("Later reply."),
          }),
        );
        await yieldImmediate();
        expect(harness.state.completed).toBe(true);
        expect(harness.sourceReplies.map((reply) => reply.text)).toEqual(["Later reply."]);
      } finally {
        harness.completeTurn();
        await yieldImmediate();
      }
    },
  );

  it.each([
    {
      label: "a later authored batch after native-only work",
      toolAuthored: true,
      sameBatch: false,
    },
    { label: "an ordinary terminal tool beside native work", toolAuthored: false, sameBatch: true },
  ])("preserves $label", async ({ toolAuthored, sameBatch }) => {
    await using harness = createTerminalReleaseHarness();
    await harness.observeResponse(sameBatch ? ["native", "reply"] : ["native"]);
    if (sameBatch) {
      harness.pendingOpenClawDynamicToolCompletionIds.add("reply");
    }
    await harness.notifyNativeItem("item/started", "inProgress");
    await harness.notifyNativeItem("item/completed", "failed", 1);
    await yieldImmediate();
    harness.pendingOpenClawDynamicToolCompletionIds.delete("reply");
    if (!sameBatch) {
      await harness.observeResponse(["reply"]);
    }
    harness.controller.recordDynamicToolResult(
      dynamicToolResult("reply", {
        success: true,
        terminate: true,
        ...(toolAuthored
          ? {
              toolAuthoredSourceReply: finalReply("Final reply."),
            }
          : {}),
      }),
    );
    await yieldImmediate();
    expect(harness.state.completed).toBe(true);
    expect(harness.sourceReplies.map((reply) => reply.text)).toEqual(
      toolAuthored ? ["Final reply."] : [],
    );
  });

  it("commits all final replies together after every sibling settles", async () => {
    const harness = createTerminalReleaseHarness();
    await harness.observeResponse(["first", "second"]);
    harness.pendingOpenClawDynamicToolCompletionIds.add("second");
    try {
      harness.controller.recordDynamicToolResult(
        dynamicToolResult("first", {
          success: true,
          terminate: true,
          toolAuthoredSourceReply: finalReply("First reply."),
        }),
      );
      await yieldImmediate();
      expect(harness.sourceReplies).toEqual([]);
      expect(harness.request).not.toHaveBeenCalled();
      harness.pendingOpenClawDynamicToolCompletionIds.delete("second");
      harness.controller.recordDynamicToolResult(
        dynamicToolResult("second", {
          success: true,
          terminate: true,
          toolAuthoredSourceReply: finalReply("Second reply."),
        }),
      );
      await yieldImmediate();
      expect(harness.sourceReplies.map((reply) => reply.text)).toEqual([
        "First reply.",
        "Second reply.",
      ]);
      expect(harness.resolveCompletion).toHaveBeenCalledOnce();
    } finally {
      harness.completeTurn();
      await yieldImmediate();
    }
  });
  it.each([{ order: ["reply", "note"] as const }, { order: ["note", "reply"] as const }])(
    "preserves ordinary terminal tools' async handoff semantics, completing $order",
    async ({ order }) => {
      const { harness } = await settleBatch([...order], {
        toolAuthored: false,
        siblingAsync: true,
      });
      await using _ = harness;
      expect(harness.state.completed).toBe(true);
      expect(harness.resolveCompletion).toHaveBeenCalledOnce();
      expect(harness.sourceReplies).toEqual([]);
    },
  );

  it("discards a mixed batch's candidates before a later final batch", async () => {
    const { harness } = await settleBatch(["reply", "note"], {
      toolAuthored: true,
      siblingAsync: true,
    });
    await using _ = harness;
    expect(harness.sourceReplies).toEqual([]);
    expect(harness.state.completed).toBe(false);
    await harness.observeResponse(["later"]);
    harness.controller.recordDynamicToolResult(
      dynamicToolResult("later", {
        success: true,
        terminate: true,
        toolAuthoredSourceReply: finalReply("Later reply."),
      }),
    );
    await yieldImmediate();
    expect(harness.sourceReplies.map((reply) => reply.text)).toEqual(["Later reply."]);
    expect(harness.resolveCompletion).toHaveBeenCalledOnce();
  });

  it.each([
    { order: ["reply", "note"] as const, expected: ["reply:open", "note:open"] },
    { order: ["note", "reply"] as const, expected: ["note:open", "reply:open"] },
  ])(
    "keeps the turn open for an unhandled sibling, completing $order",
    async ({ order, expected }) => {
      const { harness, releasedAfter } = await settleBatch([...order], { toolAuthored: true });
      try {
        expect(releasedAfter).toEqual(expected);
        expect(harness.request).not.toHaveBeenCalled();
        expect(harness.resolveCompletion).not.toHaveBeenCalled();
        expect(harness.sourceReplies).toEqual([]);
      } finally {
        harness.completeTurn();
        await yieldImmediate();
      }
    },
  );

  it.each([{ order: ["reply", "note"] as const }, { order: ["note", "reply"] as const }])(
    "does not hide a failed sibling, completing $order",
    async ({ order }) => {
      const { harness, releasedAfter } = await settleBatch([...order], {
        toolAuthored: true,
        siblingSuccess: false,
      });
      expect(releasedAfter.every((entry) => entry.endsWith(":open"))).toBe(true);
      expect(harness.request).not.toHaveBeenCalled();
      expect(harness.resolveCompletion).not.toHaveBeenCalled();
    },
  );

  it.each([{ order: ["reply", "note"] as const }, { order: ["note", "reply"] as const }])(
    "keeps an ordinary terminal tool's batch open after a non-terminal sibling, completing $order",
    async ({ order }) => {
      const { harness, releasedAfter } = await settleBatch([...order], { toolAuthored: false });

      expect(releasedAfter.every((entry) => entry.endsWith(":open"))).toBe(true);
      expect(harness.request).not.toHaveBeenCalled();
      expect(harness.sourceReplies).toEqual([]);
      expect(harness.state.currentTurnHadNonTerminalDynamicToolResult).toBe(false);
    },
  );
});

describe("Codex authored model response boundary", () => {
  it.each([
    { first: "reply", closed: false },
    { first: "terminal", closed: false },
    { first: "reply", closed: true },
    { first: "terminal", closed: true },
  ] as const)(
    "retains the authored reply beside a terminal sibling ($first first, closed=$closed)",
    async ({ first, closed }) => {
      await using h = createTerminalReleaseHarness();
      const results = {
        reply: authored("reply"),
        terminal: dynamicToolResult("terminal", { success: true, terminate: true }),
      };
      for (const callId of ["reply", "terminal"]) {
        await h.notifyRawItem(
          rawCall(callId, callId, CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE),
        );
      }
      if (closed) {
        await h.finishResponse();
      }
      h.controller.recordDynamicToolResult(results[first]);
      await yieldImmediate();
      expectUnreleased(h);

      h.controller.recordDynamicToolResult(results[first === "reply" ? "terminal" : "reply"]);
      await yieldImmediate();
      if (!closed) {
        expectUnreleased(h);
        await h.finishResponse();
        await yieldImmediate();
      }
      expect(h.sourceReplies.map((reply) => reply.text)).toEqual(["reply"]);
      expect(h.resolveCompletion).toHaveBeenCalledOnce();
      expect(h.request).toHaveBeenCalledOnce();
    },
  );

  it.each(["before", "after"] as const)(
    "waits for an unregistered authored sibling when response closes %s the ordinary result",
    async (close) => {
      await using h = createTerminalReleaseHarness();
      const replyCall = rawCall("reply", "reply", CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE);
      await h.notifyRawCall("terminal");
      if (close === "before") {
        await h.notifyRawItem(replyCall);
        await h.finishResponse();
      }
      h.controller.recordDynamicToolResult(
        dynamicToolResult("terminal", { success: true, terminate: true }),
      );
      await yieldImmediate();
      expect(h.state.completed).toBe(false);
      expect(h.cancel).not.toHaveBeenCalled();
      if (close === "after") {
        // No candidate or raw sibling was known at the preceding idle gap.
        await h.notifyRawItem(replyCall);
        await h.finishResponse();
        await yieldImmediate();
      }
      // The closed inventory, not request counters, owns this delayed call.
      expectUnreleased(h);
      h.pendingOpenClawDynamicToolCompletionIds.add("reply");
      h.controller.scheduleTerminalDynamicToolReleaseCheck();
      await yieldImmediate();
      expect(h.state.completed).toBe(false);
      h.pendingOpenClawDynamicToolCompletionIds.delete("reply");
      h.controller.recordDynamicToolResult(authored("reply"));
      await yieldImmediate();
      expect(h.sourceReplies.map((reply) => reply.text)).toEqual(["reply"]);
      expect(h.resolveCompletion).toHaveBeenCalledOnce();
      expect(h.request).toHaveBeenCalledOnce();
    },
  );

  it.each(["native", "failed", "async"] as const)(
    "does not let a terminal sibling discard an authored reply with a %s sibling",
    async (sibling) => {
      await using h = createTerminalReleaseHarness();
      await h.observeResponse(["reply", "terminal", "sibling"]);
      h.controller.recordDynamicToolResult(authored("reply"));
      if (sibling !== "native") {
        h.controller.recordDynamicToolResult(
          dynamicToolResult("sibling", {
            success: sibling === "async",
            asyncStarted: sibling === "async",
          }),
        );
      }
      h.controller.recordDynamicToolResult(
        dynamicToolResult("terminal", { success: true, terminate: true }),
      );
      await yieldImmediate();
      expectUnreleased(h);
      expect(h.request).not.toHaveBeenCalled();
    },
  );

  it.each(["before", "after"] as const)(
    "waits for response close when authored result completes %s it",
    async (order) => {
      const h = createTerminalReleaseHarness();
      await h.notifyRawCall("reply");
      if (order === "after") {
        await h.finishResponse();
      }
      h.controller.recordDynamicToolResult(authored("reply"));
      await yieldImmediate();
      if (order === "before") {
        expect(h.state.completed).toBe(false);
        expect(h.cancel).not.toHaveBeenCalled();
        expect(h.sourceReplies).toEqual([]);
        await h.finishResponse();
        await yieldImmediate();
      }
      try {
        expect(h.sourceReplies.map((reply) => reply.text)).toEqual(["reply"]);
        expect(h.resolveCompletion).toHaveBeenCalledOnce();
      } finally {
        h.completeTurn();
        await yieldImmediate();
      }
    },
  );

  it.each(["native-first", "reply-first"] as const)(
    "retains streamed siblings despite idle gaps: %s",
    async (order) => {
      await using h = createTerminalReleaseHarness();
      if (order === "native-first") {
        await h.notifyRawCall("native", "shell");
        await h.notifyNativeItem("item/started", "inProgress");
        await h.notifyNativeItem("item/completed", "failed", 1);
        await yieldImmediate();
      }
      await h.notifyRawCall("reply");
      h.controller.recordDynamicToolResult(authored("reply"));
      await yieldImmediate();
      expect(h.state.completed).toBe(false);
      if (order === "reply-first") {
        await h.notifyRawCall("native", "shell");
      }
      await h.finishResponse();
      if (order === "reply-first") {
        await h.notifyNativeItem("item/started", "inProgress");
        await h.notifyNativeItem("item/completed", "failed", 1);
      }
      await yieldImmediate();
      expect(h.state.completed).toBe(false);
      expect(h.sourceReplies).toEqual([]);
      await h.notifyRawItem({ type: "function_call_output", call_id: "native", output: "failed" });
      await h.notifyRawCall("later");
      await h.finishResponse();
      h.controller.recordDynamicToolResult(authored("later"));
      await yieldImmediate();
      expect(h.sourceReplies.map((reply) => reply.text)).toEqual(["later"]);
      expect(h.resolveCompletion).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    "accounts for a dynamic sibling registered after response close: success=%s",
    async (success) => {
      await using h = createTerminalReleaseHarness();
      await h.notifyRawCall("reply");
      await h.notifyRawCall("delayed");
      await h.finishResponse();
      h.controller.recordDynamicToolResult(authored("reply"));
      await yieldImmediate();
      expect(h.state.completed).toBe(false);
      await h.notifyRawItem({ type: "function_call_output", call_id: "reply", output: "done" });
      h.controller.recordDynamicToolResult(
        success ? authored("delayed") : dynamicToolResult("delayed", { success: false }),
      );
      await yieldImmediate();
      expect(h.state.completed).toBe(success);
      expect(h.sourceReplies.map((reply) => reply.text)).toEqual(
        success ? ["reply", "delayed"] : [],
      );
    },
  );

  it("observes model membership before queued notification projection", async () => {
    await using h = createTerminalReleaseHarness();
    h.receive({
      method: "rawResponseItem/completed",
      params: { ...scope, item: rawCall("reply") },
    });
    h.controller.recordDynamicToolResult(authored("reply"));
    await yieldImmediate();
    expect(h.state.completed).toBe(false);
    // Receipt authority admits this closed response without waiting for its UI
    // projection. Moving admission to reportExecutionNotification loses it.
    h.receive({
      method: "rawResponse/completed",
      params: { ...scope, responseId: "receipt-only" },
    });
    await yieldImmediate();
    expect(h.state.completed).toBe(true);
    expect(h.sourceReplies.map((reply) => reply.text)).toEqual(["reply"]);
  });

  it("never admits a nested result using its Code Mode outer raw call", async () => {
    const h = createTerminalReleaseHarness();
    await h.notifyRawCall("program", "exec");
    await h.finishResponse();
    h.controller.recordDynamicToolResult(authored("nested"));
    await yieldImmediate();
    expect(h.state.completed).toBe(false);
    expect(h.sourceReplies).toEqual([]);
    expect(h.cancel).not.toHaveBeenCalled();
  });
});
