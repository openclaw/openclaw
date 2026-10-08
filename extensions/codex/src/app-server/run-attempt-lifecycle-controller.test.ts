import { setImmediate as yieldImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { interruptCodexTurnAndWaitBestEffort } from "./attempt-client-cleanup.js";
import { createCodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { buildCodexLifecycleTerminalMeta } from "./run-attempt-lifecycle-terminal.js";
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
  const state = {
    completed: false,
    activeAppServerTurnRequests: 0,
    currentTurnHadNonTerminalDynamicToolResult: false,
    currentTurnHadToolAuthoredFinalReply: false,
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
  const controller = createCodexAttemptLifecycleController(
    {
      prompt: {
        context: {
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
      state: { client },
    } as never,
    {
      state,
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
    } as never,
  );
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
    completeTurn,
    controller,
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
      controller.scheduleTurnReleaseAfterTerminalDynamicTool(terminalYieldResult(true));
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
      harness.controller.scheduleTurnReleaseAfterTerminalDynamicTool(terminalYieldResult(true));
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
      harness.controller.scheduleTurnReleaseAfterTerminalDynamicTool(terminalYieldResult(true));
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
        harness.controller.scheduleTurnReleaseAfterTerminalDynamicTool(terminalYieldResult(true));
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

    harness.controller.scheduleTurnReleaseAfterTerminalDynamicTool(terminalYieldResult(false));
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
  response: { success: boolean; terminate?: boolean; toolAuthoredFinalReply?: true },
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
async function settleBatch(order: Array<"reply" | "note">, reply: { toolAuthored: boolean }) {
  const harness = createTerminalReleaseHarness();
  const results = {
    reply: dynamicToolResult("call-reply", {
      success: true,
      terminate: true,
      ...(reply.toolAuthored ? { toolAuthoredFinalReply: true as const } : {}),
    }),
    note: dynamicToolResult("call-note", { success: true }),
  };
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
    { order: ["reply", "note"] as const, expected: ["reply:open", "note:released"] },
    { order: ["note", "reply"] as const, expected: ["note:open", "reply:released"] },
  ])("releases the turn once the batch settles, completing $order", async ({ order, expected }) => {
    const { harness, releasedAfter } = await settleBatch([...order], { toolAuthored: true });
    try {
      expect(releasedAfter).toEqual(expected);
      expect(harness.request).toHaveBeenCalledWith(
        "turn/interrupt",
        { threadId: "thread-1", turnId: "turn-1" },
        expect.anything(),
      );
      expect(harness.resolveCompletion).toHaveBeenCalledOnce();
    } finally {
      harness.completeTurn();
      await yieldImmediate();
    }
  });

  it.each([{ order: ["reply", "note"] as const }, { order: ["note", "reply"] as const }])(
    "keeps an ordinary terminal tool's batch open after a non-terminal sibling, completing $order",
    async ({ order }) => {
      const { harness, releasedAfter } = await settleBatch([...order], { toolAuthored: false });

      expect(releasedAfter.every((entry) => entry.endsWith(":open"))).toBe(true);
      expect(harness.request).not.toHaveBeenCalled();
      expect(harness.state.currentTurnHadToolAuthoredFinalReply).toBe(false);
      expect(harness.state.currentTurnHadNonTerminalDynamicToolResult).toBe(false);
    },
  );
});
