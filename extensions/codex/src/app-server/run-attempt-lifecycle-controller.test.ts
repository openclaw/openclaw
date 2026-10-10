import { setImmediate as yieldImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { interruptCodexTurnAndWaitBestEffort } from "./attempt-client-cleanup.js";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
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

function createTerminalReleaseHarness() {
  const order: string[] = [];
  const notificationHandlers = new Set<(notification: unknown) => void>();
  const cancel = vi.fn(() => order.push("cancel"));
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
    steeringQueueRef: { current: { cancel } },
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

function terminalYieldResult(success: boolean) {
  return {
    call: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-yield",
      tool: "sessions_yield",
      arguments: {},
    },
    response: { success, terminate: true, contentItems: [] },
    durationMs: 1,
  };
}

describe("buildCodexLifecycleTerminalMeta", () => {
  it("marks sessions_yield as a paused parent continuation", () => {
    expect(
      buildCodexLifecycleTerminalMeta({
        aborted: false,
        timedOut: false,
        yielded: true,
      }),
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
    runtime.steeringQueueRef.current = { cancel: vi.fn() } as never;
    const interrupt = vi.spyOn(runtime, "interruptTurn");
    const controller = createCodexAttemptLifecycleController(resources as never, runtime);
    try {
      route.armTurn();
      await route.bindTurn("turn-1");
      controller.recordDynamicToolResult(terminalYieldResult(true));
      await yieldImmediate();
      expect(runtime.state.completed).toBe(true);
      expect(interrupt).toHaveBeenCalledOnce();
      const nativeCleanup = interrupt.mock.results[0]?.value;
      const settled = vi.fn();
      void nativeCleanup?.then(settled, settled);

      route.release();
      await yieldImmediate();
      expect(settled).not.toHaveBeenCalled();
      expect(physical.stdinDestroyed).toBe(false);
      expect(peerRoute.signal.aborted).toBe(false);
      physical.send({
        method: "turn/completed",
        params: {
          threadId: "thread-peer",
          turn: { id: "peer-turn", status: "completed", items: [] },
        },
      });
      await yieldImmediate();
      expect(settled).not.toHaveBeenCalled();
      physical.send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "interrupted", items: [] },
        },
      });
      await expect(nativeCleanup).resolves.toBe(true);
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
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

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
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

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
        expect(harness.cancel).toHaveBeenCalledTimes(pending === "native-item" ? 1 : 0);

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
    "success" | "terminate" | "toolAuthoredSourceReply" | "asyncStarted"
  >,
) {
  return {
    call: { threadId: "thread-1", turnId: "turn-1", callId, tool: callId, arguments: {} },
    response: { contentItems: [], ...response },
    durationMs: 1,
  };
}

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
            toolAuthoredSourceReply: {
              text: "Order created.",
              toolAuthored: true as const,
              sourceReplyFinal: true,
            },
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
            toolAuthoredSourceReply: {
              text: "Premature reply.",
              toolAuthored: true,
              sourceReplyFinal: true,
            },
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
            toolAuthoredSourceReply: {
              text: "Later reply.",
              toolAuthored: true,
              sourceReplyFinal: true,
            },
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
    const harness = createTerminalReleaseHarness();
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
    try {
      harness.controller.recordDynamicToolResult(
        dynamicToolResult("reply", {
          success: true,
          terminate: true,
          ...(toolAuthored
            ? {
                toolAuthoredSourceReply: {
                  text: "Final reply.",
                  toolAuthored: true as const,
                  sourceReplyFinal: true,
                },
              }
            : {}),
        }),
      );
      await yieldImmediate();
      expect(harness.state.completed).toBe(true);
      expect(harness.sourceReplies.map((reply) => reply.text)).toEqual(
        toolAuthored ? ["Final reply."] : [],
      );
    } finally {
      harness.completeTurn();
      await yieldImmediate();
    }
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
          toolAuthoredSourceReply: {
            text: "First reply.",
            toolAuthored: true,
            sourceReplyFinal: true,
          },
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
          toolAuthoredSourceReply: {
            text: "Second reply.",
            toolAuthored: true,
            sourceReplyFinal: true,
          },
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
      try {
        expect(harness.state.completed).toBe(true);
        expect(harness.resolveCompletion).toHaveBeenCalledOnce();
        expect(harness.sourceReplies).toEqual([]);
      } finally {
        harness.completeTurn();
        await yieldImmediate();
      }
    },
  );

  it("discards a mixed batch's candidates before a later final batch", async () => {
    const { harness } = await settleBatch(["reply", "note"], {
      toolAuthored: true,
      siblingAsync: true,
    });
    expect(harness.sourceReplies).toEqual([]);
    expect(harness.state.completed).toBe(false);
    try {
      await harness.observeResponse(["later"]);
      harness.controller.recordDynamicToolResult(
        dynamicToolResult("later", {
          success: true,
          terminate: true,
          toolAuthoredSourceReply: {
            text: "Later reply.",
            toolAuthored: true,
            sourceReplyFinal: true,
          },
        }),
      );
      await yieldImmediate();
      expect(harness.sourceReplies.map((reply) => reply.text)).toEqual(["Later reply."]);
      expect(harness.resolveCompletion).toHaveBeenCalledOnce();
    } finally {
      harness.completeTurn();
      await yieldImmediate();
    }
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
  const authored = (callId: string) =>
    dynamicToolResult(callId, {
      success: true,
      terminate: true,
      toolAuthoredSourceReply: { text: callId, toolAuthored: true, sourceReplyFinal: true },
    });

  it.each([
    { first: "reply", closed: false },
    { first: "terminal", closed: false },
    { first: "reply", closed: true },
    { first: "terminal", closed: true },
  ] as const)(
    "retains the authored reply beside a terminal sibling ($first first, closed=$closed)",
    async ({ first, closed }) => {
      const h = createTerminalReleaseHarness();
      const results = {
        reply: authored("reply"),
        terminal: dynamicToolResult("terminal", { success: true, terminate: true }),
      };
      try {
        for (const callId of ["reply", "terminal"]) {
          await h.notifyRawItem({
            type: "function_call",
            call_id: callId,
            name: callId,
            namespace: CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
            arguments: "{}",
          });
        }
        if (closed) {
          await h.finishResponse();
        }
        h.controller.recordDynamicToolResult(results[first]);
        await yieldImmediate();
        expect(h.state.completed).toBe(false);
        expect(h.cancel).not.toHaveBeenCalled();
        expect(h.sourceReplies).toEqual([]);

        h.controller.recordDynamicToolResult(results[first === "reply" ? "terminal" : "reply"]);
        await yieldImmediate();
        if (!closed) {
          expect(h.state.completed).toBe(false);
          expect(h.cancel).not.toHaveBeenCalled();
          expect(h.sourceReplies).toEqual([]);
          await h.finishResponse();
          await yieldImmediate();
        }
        expect(h.sourceReplies.map((reply) => reply.text)).toEqual(["reply"]);
        expect(h.resolveCompletion).toHaveBeenCalledOnce();
        expect(h.request).toHaveBeenCalledOnce();
      } finally {
        h.completeTurn();
        await yieldImmediate();
      }
    },
  );

  it.each(["before", "after"] as const)(
    "waits for an unregistered authored sibling when response closes %s the ordinary result",
    async (close) => {
      const h = createTerminalReleaseHarness();
      const replyCall = {
        type: "function_call",
        call_id: "reply",
        name: "reply",
        namespace: CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
        arguments: "{}",
      };
      try {
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
        expect(h.state.completed).toBe(false);
        expect(h.cancel).not.toHaveBeenCalled();
        expect(h.sourceReplies).toEqual([]);
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
      } finally {
        h.completeTurn();
        await yieldImmediate();
      }
    },
  );

  it.each(["native", "failed", "async"] as const)(
    "does not let a terminal sibling discard an authored reply with a %s sibling",
    async (sibling) => {
      const h = createTerminalReleaseHarness();
      try {
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
        expect(h.state.completed).toBe(false);
        expect(h.cancel).not.toHaveBeenCalled();
        expect(h.sourceReplies).toEqual([]);
        expect(h.request).not.toHaveBeenCalled();
      } finally {
        h.completeTurn();
        await yieldImmediate();
      }
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
      const h = createTerminalReleaseHarness();
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
      try {
        expect(h.sourceReplies.map((reply) => reply.text)).toEqual(["later"]);
        expect(h.resolveCompletion).toHaveBeenCalledOnce();
      } finally {
        h.completeTurn();
        await yieldImmediate();
      }
    },
  );

  it.each([true, false])(
    "accounts for a dynamic sibling registered after response close: success=%s",
    async (success) => {
      const h = createTerminalReleaseHarness();
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
      try {
        expect(h.state.completed).toBe(success);
        expect(h.sourceReplies.map((reply) => reply.text)).toEqual(
          success ? ["reply", "delayed"] : [],
        );
      } finally {
        h.completeTurn();
        await yieldImmediate();
      }
    },
  );

  it("observes model membership before queued notification projection", async () => {
    const h = createTerminalReleaseHarness();
    const params = { threadId: "thread-1", turnId: "turn-1" };
    h.receive({
      method: "rawResponseItem/completed",
      params: {
        ...params,
        item: {
          type: "function_call",
          call_id: "reply",
          name: "reply",
          arguments: "{}",
        },
      },
    });
    h.controller.recordDynamicToolResult(authored("reply"));
    await yieldImmediate();
    expect(h.state.completed).toBe(false);
    // Receipt authority admits this closed response without waiting for its UI
    // projection. Moving admission to reportExecutionNotification loses it.
    h.receive({
      method: "rawResponse/completed",
      params: { ...params, responseId: "receipt-only" },
    });
    await yieldImmediate();
    try {
      expect(h.state.completed).toBe(true);
      expect(h.sourceReplies.map((reply) => reply.text)).toEqual(["reply"]);
    } finally {
      h.completeTurn();
      await yieldImmediate();
    }
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
