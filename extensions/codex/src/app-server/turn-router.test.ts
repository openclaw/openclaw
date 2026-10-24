import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { JsonObject, JsonValue } from "./protocol.js";
import {
  completedNotification,
  expectDelivery,
  unhandledToolResult,
  useRouterHarness,
} from "./turn-router.fixture.test-support.js";
import { settleInput, waitForResponse, type WireResponse } from "./turn-router.test-support.js";

const CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS = 660_000;
const createHarness = useRouterHarness();

async function bindRoute(
  harness: ReturnType<typeof createHarness>,
  turnId: string,
  handlers: Parameters<typeof harness.reserve>[0] = { onNotification: vi.fn() },
) {
  const route = harness.reserve(handlers);
  route.armTurn();
  await route.bindTurn(turnId);
  return route;
}

describe("CodexAppServerTurnRouter", () => {
  it.each(["reserve", "activate"] as const)(
    "runs %s callbacks in each attempt's context on a reused transport",
    async (registration) => {
      const context = new AsyncLocalStorage<string>();
      const transport = context.run("first", () => new AsyncResource("codex-test-transport"));
      const harness = createHarness();
      const router = harness.router;
      try {
        for (const owner of ["first", "second"]) {
          const notifications: Array<{ owner: string | undefined; unbound: boolean }> = [];
          const receipts: Array<{ owner: string | undefined; originalReceiver: boolean }> = [];
          const handlers = {
            async onRequest(this: unknown) {
              await Promise.resolve();
              return { owner: context.getStore() ?? "missing", unbound: this === undefined };
            },
            async onNotification(this: unknown) {
              await Promise.resolve();
              notifications.push({ owner: context.getStore(), unbound: this === undefined });
            },
            onNotificationReceived(this: unknown) {
              receipts.push({
                owner: context.getStore(),
                originalReceiver: this === originalHandlers,
              });
            },
          };
          const options = { threadId: "shared-thread", ...handlers };
          const originalHandlers: object = registration === "reserve" ? options : handlers;
          const route = context.run(registration === "reserve" ? owner : "reservation", () =>
            router.reserveThread(
              registration === "reserve" ? options : { threadId: "shared-thread" },
            ),
          );
          try {
            if (registration === "activate") {
              await context.run(owner, () => route.activate(handlers));
            }
            route.armTurn();
            await route.bindTurn(owner);
            const notification = {
              method: "item/agentMessage/delta",
              params: { threadId: "shared-thread", turnId: owner, delta: owner },
            };
            transport.runInAsyncScope(() => {
              harness.send(notification);
              harness.request(owner, "item/tool/call", {
                threadId: "shared-thread",
                turnId: owner,
                tool: "message",
              });
            });
            expect(await waitForResponse(harness, owner)).toMatchObject({
              result: { owner, unbound: true },
            });
            await route.drain();
            expect(notifications).toEqual([{ owner, unbound: true }]);
            expect(receipts).toEqual([{ owner, originalReceiver: true }]);
            route.release();
            transport.runInAsyncScope(() => harness.send(notification));
            await settleInput();
            expect(notifications).toHaveLength(1);
            expect(receipts).toHaveLength(1);
          } finally {
            route.release();
          }
        }
      } finally {
        transport.emitDestroy();
        context.disable();
      }
    },
  );

  it("delivers global startup warnings to the next reserved thread", async () => {
    const harness = createHarness("thread-warnings");
    const warning = {
      method: "configWarning",
      params: { summary: "Custom execution rules were not applied." },
    };
    harness.send(warning);
    const notifications = vi.fn();

    await bindRoute(harness, "turn-warnings", { onNotification: notifications });

    await vi.waitFor(() =>
      expectDelivery(notifications, warning, { threadId: "thread-warnings" }, {}),
    );
  });

  it("records a diagnostic-log failure once instead of replaying it across turns", async () => {
    const message =
      "Codex couldn't save diagnostic logs to its local database. Use /feedback with logs included before closing Codex, or run `codex doctor` for diagnostics.";
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createHarness();
    const router = harness.router;
    const notifications = vi.fn();
    const routes = ["thread-first", "thread-sibling"].map((threadId) =>
      router.reserveThread({ threadId, onNotification: notifications }),
    );
    for (const route of routes) {
      route.armTurn();
      await route.bindTurn("turn-first");
    }

    harness.notify("warning", { threadId: null, message });
    await Promise.all(routes.map((route) => route.drain()));
    expect(notifications).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith(message);
    for (const route of routes) {
      route.release();
    }

    const later = router.reserveThread({
      threadId: "thread-first",
      onNotification: notifications,
    });
    later.armTurn();
    await later.bindTurn("turn-later");
    expect(notifications).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    later.release();
  });

  it("does not dispatch a request that times out before route activation", async () => {
    vi.useFakeTimers();
    vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createHarness("thread-late", "turn-late");
    const requestHandler = vi.fn(() => ({ executed: true }));
    const route = harness.reserve();

    harness.call("request-late", "item/tool/call", { tool: "message" });
    await vi.advanceTimersByTimeAsync(CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS);
    expect(await waitForResponse(harness, "request-late")).toMatchObject({
      id: "request-late",
      result: { success: false },
    });

    await route.activate({ onRequest: requestHandler });

    expect(requestHandler).not.toHaveBeenCalled();
  });

  it("keeps execution budgets with the matching thread owner", async () => {
    vi.useFakeTimers();
    vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createHarness();
    const router = harness.router;
    const signals = new Map<string, AbortSignal>();
    for (const [threadId, timeoutMs] of [
      ["long", 900_000],
      ["short", 60_000],
    ] as const) {
      const route = router.reserveThread({
        threadId,
        onRequest: (_request, scope, signal, setExecutionTimeoutMs) => {
          signals.set(scope.threadId, signal);
          setExecutionTimeoutMs?.(timeoutMs);
          return new Promise<never>(() => {});
        },
      });
      route.armTurn();
      await route.bindTurn(`turn-${threadId}`);
      harness.request(threadId, "item/tool/call", {
        threadId,
        turnId: `turn-${threadId}`,
        tool: "node_exec",
      });
    }

    await vi.advanceTimersByTimeAsync(90_000);
    expect(signals.get("short")?.aborted).toBe(true);
    expect(signals.get("long")?.aborted).toBe(false);
    expect(harness.writes.map((line) => JSON.parse(line))).toMatchObject([
      { id: "short", result: { success: false } },
    ]);

    await vi.advanceTimersByTimeAsync(840_000);
    expect(signals.get("long")?.aborted).toBe(true);
    expect(harness.writes.map((line) => JSON.parse(line))).toMatchObject([
      { id: "short", result: { success: false } },
      { id: "long", result: { success: false } },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not extend an aborted route's request with a late owner budget", async () => {
    vi.useFakeTimers();
    vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createHarness("released");
    let setExecutionTimeoutMs: ((timeoutMs: number | null) => void) | undefined;
    const route = harness.reserve({
      onRequest: (_request, _scope, _signal, setTimeoutMs) => {
        setExecutionTimeoutMs = setTimeoutMs;
        return new Promise<never>(() => {});
      },
    });
    harness.request("released", "item/tool/call", { threadId: "released", tool: "node_exec" });
    await vi.advanceTimersByTimeAsync(0);
    expect(setExecutionTimeoutMs).toBeTypeOf("function");
    route.release();
    setExecutionTimeoutMs?.(900_000);

    await vi.advanceTimersByTimeAsync(CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS);
    expect(harness.writes.map((line) => JSON.parse(line))).toMatchObject([
      { id: "released", result: { success: false } },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("routes concurrent traffic to the exact thread and turn", async () => {
    const harness = createHarness("thread-2", "turn-2");
    const router = harness.router;
    const firstNotifications = vi.fn();
    const secondNotifications = vi.fn();
    const firstRequests = vi.fn(() => ({ owner: "first" }));
    const secondRequests = vi.fn(() => ({ owner: "second" }));
    const first = router.reserveThread({
      threadId: "thread-1",
      onNotification: firstNotifications,
      onRequest: firstRequests,
    });
    const second = router.reserveThread({
      threadId: "thread-2",
      onNotification: secondNotifications,
      onRequest: secondRequests,
    });
    first.armTurn();
    second.armTurn();
    await Promise.all([first.bindTurn("turn-1"), second.bindTurn("turn-2")]);

    harness.turn("item/agentMessage/delta", { delta: "right" });
    harness.complete();
    harness.turn("item/agentMessage/delta", { turnId: "turn-stale", delta: "wrong" });
    harness.call("request-2", "item/tool/call", { tool: "second" });
    harness.request("request-1", "item/tool/call", {
      threadId: "thread-1",
      turnId: "turn-1",
      tool: "first",
    });

    await vi.waitFor(() => expect(secondNotifications).toHaveBeenCalledTimes(2));
    await harness.expectResponse("request-1", { owner: "first" });
    await harness.expectResponse("request-2", { owner: "second" });

    expect(firstNotifications).not.toHaveBeenCalled();
    expectDelivery(
      secondNotifications,
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thread-2", turnId: "turn-2", delta: "right" },
      },
      { threadId: "thread-2", turnId: "turn-2" },
    );
    expectDelivery(
      secondNotifications,
      completedNotification("thread-2", "turn-2"),
      { threadId: "thread-2", turnId: "turn-2" },
      {
        threadId: "thread-2",
        turnId: "turn-2",
        completedTurn: { id: "turn-2", status: "completed", items: [] },
      },
    );
    expect(firstRequests).toHaveBeenCalledTimes(1);
    expect(secondRequests).toHaveBeenCalledTimes(1);
  });

  it("warns once only for a thread-correlated stale turn notification", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createHarness("thread-1");
    const notifications = vi.fn();
    await bindRoute(harness, "turn-current", { onNotification: notifications });
    for (let repeat = 0; repeat < 2; repeat++) {
      harness.turn("item/agentMessage/delta", {
        turnId: "turn-stale",
        itemId: "msg-stale",
        delta: "ignored",
      });
    }
    harness.notify("thread/status/changed", { threadId: "thread-1", status: { type: "active" } });
    harness.notify("configWarning", { message: "global" });
    await settleInput();

    expect(notifications).toHaveBeenCalledTimes(2);
    expectDelivery(
      notifications,
      {
        method: "thread/status/changed",
        params: { threadId: "thread-1", status: { type: "active" } },
      },
      { threadId: "thread-1" },
    );
    expectDelivery(
      notifications,
      { method: "configWarning", params: { message: "global" } },
      { threadId: "thread-1" },
      {},
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "codex app-server notification ignored for inactive turn",
      {
        eventKind: "item/agentMessage/delta",
        activeThreadId: "thread-1",
        activeTurnId: "turn-current",
        threadId: "thread-1",
        turnId: "turn-stale",
        matchesActiveThread: true,
        matchesActiveTurn: false,
      },
    );
  });

  it("buffers pre-bind notifications in order and filters the bound turn", async () => {
    const harness = createHarness("thread-1", "turn-1");
    const methods: string[] = [];
    const receivedMethods: string[] = [];
    const route = harness.reserve({
      onNotificationReceived: (notification) => {
        receivedMethods.push(notification.method);
      },
      onNotification: async (notification) => {
        await Promise.resolve();
        methods.push(notification.method);
      },
    });
    route.armTurn();

    harness.notify("thread/started", { thread: { id: "thread-1" } });
    harness.turn("item/started");
    harness.notify("thread/status/changed", { threadId: "thread-1", status: { type: "active" } });
    harness.turn("item/completed", { turnId: "turn-stale" });
    harness.turn("turn/started");
    await settleInput();

    expect(methods).toEqual([]);
    expect(receivedMethods).toEqual([]);
    await route.bindTurn("turn-1");

    const expectedMethods = [
      "thread/started",
      "item/started",
      "thread/status/changed",
      "turn/started",
    ];
    expect(receivedMethods).toEqual(expectedMethods);
    expect(methods).toEqual(expectedMethods);
  });

  it("flushes prior notifications before releasing a paused bound request", async () => {
    const harness = createHarness("thread-ordered", "turn-ordered");
    const events: string[] = [];
    const received: string[] = [];
    const beforeNotifications = createDeferred<void>();
    const firstPending = createDeferred<void>();
    const route = harness.reserve({
      onNotificationReceived: (notification) => {
        received.push(notification.method);
      },
      onNotification: async (notification) => {
        events.push(`${notification.method}:start`);
        if (notification.method === "item/started") {
          await firstPending.promise;
        }
        events.push(`${notification.method}:end`);
      },
      onRequest: () => {
        events.push("request");
        return { success: true, contentItems: [] };
      },
    });
    route.armTurn();
    harness.turn("item/started");
    harness.turn("item/agentMessage/delta", { delta: "done" });
    harness.call("request-ordered", "item/tool/call", { tool: "message" });

    const binding = route.bindTurn("turn-ordered", {
      beforeNotifications: beforeNotifications.promise,
    });
    const drained = vi.fn();
    const draining = route.drain().then(drained);
    try {
      harness.notify("configWarning", { message: "global warning" });
      harness.send(completedNotification(route.threadId, "turn-stale"));
      harness.send(completedNotification(route.threadId, "turn-ordered"));
      await settleInput();
      const expectedReceipts = [
        "item/started",
        "item/agentMessage/delta",
        "configWarning",
        "turn/completed",
      ];
      expect(received).toEqual(expectedReceipts);
      expect(route.completed).toBe(true);
      expect(events).toEqual([]);
      expect(drained).not.toHaveBeenCalled();
      expect(harness.writes).toEqual([]);

      beforeNotifications.resolve();
      await vi.waitFor(() => expect(events).toEqual(["item/started:start"]));
      expect(drained).not.toHaveBeenCalled();
      expect(harness.writes).toEqual([]);
      firstPending.resolve();
      await binding;
      await draining;
      await harness.expectResponse("request-ordered", { success: true, contentItems: [] });
      expect(received).toEqual(expectedReceipts);
      expect(events).toEqual([
        ...expectedReceipts.flatMap((method) => [`${method}:start`, `${method}:end`]),
        "request",
      ]);
    } finally {
      beforeNotifications.resolve();
      firstPending.resolve();
      route.release();
      await binding.catch(() => undefined);
      await draining;
    }
  });

  it("records receipt synchronously and drains accepted work before release", async () => {
    const harness = createHarness("thread-receive", "turn-receive");
    const events: string[] = [];
    const firstPending = createDeferred<void>();
    const route = harness.reserve({
      onNotificationReceived: (notification) => {
        events.push(`${notification.method}:received`);
      },
      onNotification: async (notification) => {
        events.push(`${notification.method}:start`);
        if (notification.method === "item/started") {
          await firstPending.promise;
        }
        events.push(`${notification.method}:end`);
      },
    });
    harness.turn("item/started");
    harness.turn("item/completed");

    await vi.waitFor(() => expect(events).toContain("item/started:start"));
    expect(events.slice(0, 3)).toEqual([
      "item/started:received",
      "item/completed:received",
      "item/started:start",
    ]);

    firstPending.resolve();
    await route.drain();
    expect(events).toEqual([
      "item/started:received",
      "item/completed:received",
      "item/started:start",
      "item/started:end",
      "item/completed:start",
      "item/completed:end",
    ]);
    route.release();
  });

  it("drain resolves after release while a handler is blocked and routing waiters are pending", async () => {
    vi.useFakeTimers();
    const harness = createHarness("thread-release-tail", "turn-release-tail");
    const handler = vi.fn(() => new Promise<void>(() => {}));
    const route = harness.reserve({
      onNotification: handler,
      onRequest: () => ({ decision: "accept" }),
    });
    route.armTurn();
    harness.turn("item/started");
    harness.call("request-release-tail", "item/commandExecution/requestApproval", {
      itemId: "item-1",
    });
    const binding = expect(route.bindTurn("turn-release-tail")).rejects.toThrow(
      "thread route is released",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledOnce();
    const result = Promise.race([
      Promise.all([route.drain(), binding]).then(() => "drained"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("still blocked"), 1);
      }),
    ]);

    route.release();
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toBe("drained");
    await harness.expectResponse("request-release-tail", { decision: "decline" });
  });

  it("delivers open-route notifications while an armed route waits", async () => {
    const harness = createHarness();
    const router = harness.router;
    const threadHandler = vi.fn();
    const turnHandler = vi.fn();
    router.reserveThread({ threadId: "thread-live", onNotification: threadHandler });
    const turnRoute = router.reserveThread({
      threadId: "thread-buffered",
      onNotification: turnHandler,
    });
    turnRoute.armTurn();

    const liveNotification = {
      method: "thread/status/changed",
      params: { threadId: "thread-live", status: { type: "active" } },
    };
    const bufferedNotification = {
      method: "item/started",
      params: { threadId: "thread-buffered", turnId: "turn-buffered" },
    };
    harness.send(liveNotification);
    harness.send(bufferedNotification);

    await vi.waitFor(() =>
      expectDelivery(threadHandler, liveNotification, { threadId: "thread-live" }),
    );
    expect(turnHandler).not.toHaveBeenCalled();

    await turnRoute.bindTurn("turn-buffered");
    expectDelivery(turnHandler, bufferedNotification, {
      threadId: "thread-buffered",
      turnId: "turn-buffered",
    });
  });

  it("holds dormant traffic until one-shot activation", async () => {
    const harness = createHarness("thread-dormant", "turn-dormant");
    const events: string[] = [];
    const route = harness.reserve();
    route.armTurn();

    harness.notify("thread/status/changed", {
      threadId: "thread-dormant",
      status: { type: "active" },
    });
    harness.turn("item/started");
    harness.call("request-dormant-thread", "mcpServer/elicitation/request", { turnId: null });
    harness.call("request-dormant-turn", "item/tool/call");
    await settleInput();

    expect(events).toEqual([]);
    expect(harness.writes).toEqual([]);
    expect(route.signal.aborted).toBe(false);
    await expect(route.bindTurn("turn-dormant")).rejects.toThrow(
      "thread route must be activated before binding a turn",
    );
    await expect(route.activate({})).rejects.toThrow(
      "thread route requires a notification or request handler",
    );

    await route.activate({
      onNotification: async (notification) => {
        await Promise.resolve();
        events.push(`notification:${notification.method}`);
      },
      onRequest: (request): JsonValue => {
        events.push(`request:${request.method}`);
        return request.method === "item/tool/call"
          ? { success: true, contentItems: [] }
          : { action: "accept" };
      },
    });

    expect(events).toEqual([]);
    expect(harness.writes.map((line) => JSON.parse(line) as WireResponse)).not.toContainEqual(
      expect.objectContaining({ id: "request-dormant-turn" }),
    );

    await route.bindTurn("turn-dormant");
    expect(events.slice(0, 2)).toEqual([
      "notification:thread/status/changed",
      "notification:item/started",
    ]);
    await harness.expectResponse("request-dormant-thread", { action: "accept" });
    await harness.expectResponse("request-dormant-turn", { success: true, contentItems: [] });
    expect(events.at(-1)).toBe("request:item/tool/call");
    await expect(route.activate({ onRequest: vi.fn() })).rejects.toThrow(
      "thread route already activated",
    );
  });

  it.each([true, false])(
    "validates queued turn-scoped requests after binding (matches: %s)",
    async (matches) => {
      const harness = createHarness("thread-match", "turn-match");
      const handler = vi.fn(() => ({ success: true, contentItems: [] }));
      const route = harness.reserve({ onRequest: handler });
      route.armTurn();
      harness.call("request-match", "item/tool/call", { tool: "message" });
      await settleInput();
      expect(handler).not.toHaveBeenCalled();
      expect(harness.writes).toEqual([]);

      await route.bindTurn(matches ? "turn-match" : "turn-current");
      await harness.expectResponse(
        "request-match",
        matches ? { success: true, contentItems: [] } : unhandledToolResult,
      );
      expect(handler).toHaveBeenCalledTimes(matches ? 1 : 0);
    },
  );

  it("keeps resumed-turn requests open until a new turn is armed", async () => {
    const harness = createHarness("thread-resumed", "turn-old");
    const handler = vi.fn(() => undefined);
    const notificationHandler = vi.fn();
    const route = harness.reserve({ onRequest: handler, onNotification: notificationHandler });

    harness.call("old-turn-request", "item/commandExecution/requestApproval", {
      itemId: "item-old",
    });
    await harness.expectResponse("old-turn-request", { decision: "decline" });
    expect(handler).toHaveBeenCalledTimes(1);

    route.armTurn();
    harness.call("pending-turn-request", "item/commandExecution/requestApproval", {
      turnId: "turn-next",
      itemId: "item-next",
    });
    const earlyError = {
      method: "error",
      params: { threadId: "thread-resumed", message: "turn start failed" },
    };
    harness.send(earlyError);
    await settleInput();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(notificationHandler).not.toHaveBeenCalled();

    await route.cancelTurn();
    expectDelivery(notificationHandler, earlyError, { threadId: "thread-resumed" });
    await harness.expectResponse("pending-turn-request", { decision: "decline" });
    expect(handler).toHaveBeenCalledTimes(2);

    route.armTurn();
    await route.bindTurn("turn-final");
    route.release();
  });
});

describe("CodexAppServerTurnRouter lifecycle", () => {
  it.each<[string, JsonObject, boolean]>([
    [
      "strict Guardian denial interruption",
      {
        id: "turn-native",
        status: "interrupted",
        items: [],
        error: {
          message: "Guardian stopped the turn after repeated denials.",
          codexErrorInfo: "tooManyDenials",
        },
      },
      true,
    ],
    ["missing status", { id: "turn-native", items: [] }, false],
  ])("validates native completion from %s", async (_label, turn, completed) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createHarness("thread-native", "turn-native");
    const route = await bindRoute(harness, "turn-native");
    const watch = harness.watch("turn-native", { timeoutMs: 1_000 });
    harness.notify("turn/completed", { threadId: route.threadId, turn });
    await settleInput();
    expect(route.completed).toBe(completed);
    expect(watch.state).toBe(completed ? "confirmed" : "pending");
    if (!completed) {
      harness.complete();
    }
    await expect(watch.completion).resolves.toBe(true);
    expect(route.completed).toBe(true);
  });

  it.each([false, true])(
    "retains terminal facts until recovery or route renewal (bound: %s)",
    async (bound) => {
      const harness = createHarness("thread-native");
      const router = harness.router;
      const route = harness.reserve();
      if (bound) {
        await route.activate({ onNotification: vi.fn() });
        route.armTurn();
        await route.bindTurn("turn-native");
      }
      harness.send(completedNotification("thread-native", "turn-native"));
      await settleInput();
      if (!bound) {
        await route.activate({ onNotification: vi.fn() });
      }
      expect(route.observedNativeTurnId).toBe("turn-native");
      const completion = (turnId: string, timeoutMs: number) =>
        router.watchNativeTurnCompletion({ threadId: route.threadId, turnId, timeoutMs })
          .completion;
      await expect(completion("turn-native", 10)).resolves.toBe(true);
      await expect(completion("turn-native", 1)).resolves.toBe(true);

      harness.send({
        method: "turn/started",
        params: { threadId: "thread-native", turn: { id: "turn-native", status: "inProgress" } },
      });
      await settleInput();
      await expect(completion("turn-native", 1)).resolves.toBe(false);
      harness.send(completedNotification("thread-native", "turn-native"));

      harness.send(completedNotification("thread-native", "turn-stale"));
      await settleInput();
      if (bound) {
        route.release();
        const nextRoute = router.reserveThread({ threadId: route.threadId });
        await expect(completion("turn-native", 1)).resolves.toBe(false);
        nextRoute.release();
      } else {
        route.armTurn();
        expect(route.observedNativeTurnId).toBeUndefined();
        await expect(completion("turn-stale", 1)).resolves.toBe(false);
        await route.cancelTurn();
      }
    },
  );

  it("keeps an observed active native turn exact across arm and stale completion", async () => {
    const harness = createHarness("thread-native-active");
    const route = harness.reserve({ onNotification: vi.fn() });
    harness.send({
      method: "turn/started",
      params: {
        threadId: "thread-native-active",
        turn: { id: "turn-compact", status: "inProgress" },
      },
    });
    await settleInput();

    route.armTurn();
    expect(route.observedNativeTurnId).toBe("turn-compact");
    harness.send(completedNotification("thread-native-active", "turn-stale"));
    await settleInput();
    expect(route.observedNativeTurnId).toBe("turn-compact");

    const completed = harness.watch("turn-compact");
    harness.send(completedNotification("thread-native-active", "turn-compact"));
    await expect(completed.completion).resolves.toBe(true);
    await route.cancelTurn();
  });

  it("settles exact native-completion watchers on completion, abort, and route release", async () => {
    const harness = createHarness("thread-native-wait");
    const route = harness.reserve({ onNotification: vi.fn() });

    const completed = harness.watch("turn-native");
    harness.send(completedNotification("thread-native-wait", "turn-native"));
    await expect(completed.completion).resolves.toBe(true);

    const controller = new AbortController();
    const aborted = harness.watch("turn-aborted", { signal: controller.signal });
    controller.abort("test");
    await expect(aborted.completion).resolves.toBe(false);
    const alreadyAborted = harness.watch("turn-aborted", { signal: controller.signal });
    await expect(alreadyAborted.completion).resolves.toBe(false);

    const released = harness.watch("turn-released", { signal: route.signal });
    route.release();
    await expect(released.completion).resolves.toBe(false);
  });

  it("watches one exact native turn without reserving its thread", async () => {
    const harness = createHarness("thread-native-watch");
    const watch = harness.watch("turn-target");
    const settled = vi.fn();
    void watch.completion.then(settled);

    const route = harness.reserve({ onNotification: vi.fn() });
    route.release();
    harness.send(completedNotification("thread-native-watch", "turn-other"));
    await settleInput();
    expect(settled).not.toHaveBeenCalled();

    harness.send(completedNotification("thread-native-watch", "turn-target"));
    await expect(watch.completion).resolves.toBe(true);
  });

  it("keeps a hard completion deadline despite exact-turn progress", async () => {
    vi.useFakeTimers();
    const harness = createHarness("thread-native-progress", "turn-native-progress");
    const watch = harness.watch("turn-native-progress", { timeoutMs: 1_000 });

    await vi.advanceTimersByTimeAsync(900);
    harness.turn("item/agentMessage/delta", { delta: "working" });
    await vi.advanceTimersByTimeAsync(101);
    await expect(watch.completion).resolves.toBe(false);
  });

  it("settles detached native-turn watches on client close", async () => {
    const closeHarness = createHarness("thread-native-close");
    const closed = closeHarness.watch("turn-native-close");
    closeHarness.client.close();
    await expect(closed.completion).resolves.toBe(false);
  });

  it("releases pending requests and removes routes on cleanup", async () => {
    const harness = createHarness("thread-release", "turn-release");
    const router = harness.router;
    const notificationHandler = vi.fn();
    const requestHandler = vi.fn(() => ({ decision: "accept" }));
    const route = harness.reserve({
      onNotification: notificationHandler,
      onRequest: requestHandler,
    });
    route.armTurn();
    harness.call("request-release", "item/commandExecution/requestApproval", { itemId: "item-1" });
    await settleInput();

    route.release();
    harness.turn("item/started");

    await harness.expectResponse("request-release", { decision: "decline" });
    expect(notificationHandler).not.toHaveBeenCalled();
    expect(requestHandler).not.toHaveBeenCalled();

    const activeHandler = vi.fn(
      (request: { id: number | string }, _scope: unknown, signal: AbortSignal) =>
        new Promise<{ decision: string }>((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              if (request.id === "request-active-reject") {
                reject(new Error("stale request failure"));
                return;
              }
              resolve({ decision: "accept" });
            },
            { once: true },
          );
        }),
    );
    const activeRoute = router.reserveThread({
      threadId: "thread-active",
      onRequest: activeHandler,
    });
    activeRoute.armTurn();
    await activeRoute.bindTurn("turn-active");
    for (const [id, itemId] of [
      ["request-active", "item-2"],
      ["request-active-reject", "item-3"],
    ]) {
      harness.send({
        id,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-active", turnId: "turn-active", itemId },
      });
    }
    await vi.waitFor(() => expect(activeHandler).toHaveBeenCalledTimes(2));
    const activeSignals = () => activeHandler.mock.calls.map((call) => call[2].aborted);
    expect(activeSignals()).toEqual([false, false]);

    activeRoute.release();
    expect(activeSignals()).toEqual([true, true]);

    await harness.expectResponse("request-active", { decision: "decline" });
    await harness.expectResponse("request-active-reject", { decision: "decline" });

    const closingRoute = router.reserveThread({
      threadId: "thread-close",
      onRequest: activeHandler,
    });
    closingRoute.armTurn();
    await closingRoute.bindTurn("turn-close");
    harness.request("request-close", "item/commandExecution/requestApproval", {
      threadId: "thread-close",
      turnId: "turn-close",
      itemId: "item-4",
    });
    await vi.waitFor(() => expect(activeHandler).toHaveBeenCalledTimes(3));
    harness.send(completedNotification("thread-close", "turn-close"));
    harness.process.stderr.write("fatal transport detail\n");
    harness.process.emit("exit", 17, "SIGTERM");

    expect(closingRoute).toMatchObject({ completed: true, signal: { aborted: true } });
    await expect(closingRoute.bindTurn("turn-close")).rejects.toThrow("turn router closed");
    expect(activeHandler.mock.calls[2]?.[2].aborted).toBe(true);
    expect(closingRoute.signal.reason).toEqual(
      new Error("codex app-server turn router closed", {
        cause: new Error(
          'codex app-server exited: code=17 signal=SIGTERM stderr="fatal transport detail"',
        ),
      }),
    );
    expect(() =>
      router.reserveThread({ threadId: "thread-late", onRequest: requestHandler }),
    ).toThrow("turn router is closed");
  });

  it.each(["stale completion", "explicit release"] as const)(
    "does not drain a closed route after %s",
    async (reason) => {
      vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
      const harness = createHarness("thread-closed");
      const notifications = vi.fn();
      const route = harness.reserve({ onNotification: notifications });
      route.armTurn();
      harness.send(
        completedNotification(
          route.threadId,
          reason === "stale completion" ? "turn-stale" : "turn-current",
        ),
      );
      if (reason === "explicit release") {
        route.release();
      }
      harness.client.close();

      await expect(
        route.bindTurn("turn-current", { completed: reason !== "stale completion" }),
      ).rejects.toThrow(
        reason === "stale completion" ? "turn router closed" : "thread route is released",
      );
      expect(route.signal.aborted).toBe(true);
      expect(notifications).not.toHaveBeenCalled();
    },
  );

  it("releases dormant waiters and aborts the reservation", async () => {
    const harness = createHarness("thread-dormant-release", "turn-1");
    const route = harness.reserve();
    harness.call("request-dormant-release", "item/tool/call");
    await settleInput();

    route.release();

    expect(route.signal.aborted).toBe(true);
    expect(route.signal.reason).toEqual(new Error("codex app-server thread route is released"));
    await expect(route.activate({ onRequest: vi.fn() })).rejects.toThrow(
      "thread route is released",
    );
    await expect(route.bindTurn("turn-1")).rejects.toThrow("thread route is released");
    await harness.expectResponse("request-dormant-release", unhandledToolResult);
  });

  it("drains an exact terminal receipt after physical closure releases a paused route", async () => {
    const harness = createHarness("thread-closed-paused");
    const notifications = vi.fn();
    const receipts = vi.fn();
    const beforeNotifications = createDeferred<void>();
    const route = harness.reserve({
      onNotification: notifications,
      onNotificationReceived: receipts,
    });
    route.armTurn();
    const started = {
      method: "item/started",
      params: { threadId: route.threadId, turnId: "turn-current" },
    };
    harness.send(started);
    const binding = route.bindTurn("turn-current", {
      beforeNotifications: beforeNotifications.promise,
    });
    const settled = vi.fn();
    void binding.then(settled, settled);
    const completed = completedNotification(route.threadId, "turn-current");
    const scope = { threadId: "thread-closed-paused", turnId: "turn-current" };
    const expectedNotifications = [
      { ...started, ...scope, completedTurn: undefined },
      { ...completed, ...scope, completedTurn: completed.params.turn },
    ];
    try {
      harness.send(completed);
      harness.process.emit("exit", 0, null);
      await route.drain();
      await settleInput();

      expect(route).toMatchObject({ completed: true, signal: { aborted: true } });
      expect(receipts.mock.calls.map(([notification]) => notification)).toEqual(
        expectedNotifications,
      );
      expect(notifications).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();

      beforeNotifications.resolve();
      await binding;
      expect(notifications.mock.calls.map(([notification]) => notification)).toEqual(
        expectedNotifications,
      );
      expect(receipts).toHaveBeenCalledTimes(2);
    } finally {
      beforeNotifications.resolve();
      await binding.catch(() => undefined);
      route.release();
    }
  });

  it.each([
    { label: "pre-bind notifications", paused: false, overflowMethod: "item/started" },
    { label: "paused notifications", paused: true, overflowMethod: "item/started" },
    { label: "paused global warnings", paused: true, overflowMethod: "configWarning" },
  ])(
    "fails and removes a route when its buffer is full of $label",
    async ({ paused, overflowMethod }) => {
      vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
      const harness = createHarness("thread-overflow", "turn-overflow");
      const router = harness.router;
      const notifications = vi.fn();
      const requests = vi.fn(() => ({ decision: "accept" }));
      const siblingNotifications = vi.fn();
      router.reserveThread({ threadId: "thread-sibling", onNotification: siblingNotifications });
      const route = harness.reserve({ onNotification: notifications, onRequest: requests });
      route.armTurn();
      const beforeNotifications = createDeferred<void>();
      const binding = paused
        ? route.bindTurn("turn-overflow", { beforeNotifications: beforeNotifications.promise })
        : undefined;
      void binding?.catch(() => undefined);
      harness.request("request-overflow", "item/commandExecution/requestApproval", {
        threadId: route.threadId,
        turnId: "turn-overflow",
        itemId: "item-overflow",
      });
      for (let index = 0; index < 256; index += 1) {
        harness.turn("item/started");
      }
      await settleInput();
      try {
        expect(route.signal.aborted).toBe(false);
        expect(notifications).not.toHaveBeenCalled();
        expect(requests).not.toHaveBeenCalled();
        harness.send({
          method: overflowMethod,
          params:
            overflowMethod === "configWarning"
              ? { message: "global overflow" }
              : { threadId: route.threadId, turnId: "turn-overflow" },
        });
        await settleInput();

        expect(route.signal.aborted).toBe(true);
        await expect(binding ?? route.bindTurn("turn-overflow")).rejects.toThrow(
          "pre-bind notification buffer exceeded 256 entries",
        );
        await harness.expectResponse("request-overflow", { decision: "decline" });
        beforeNotifications.resolve();
        await settleInput();
        expect(notifications).not.toHaveBeenCalled();
        expect(requests).not.toHaveBeenCalled();

        const siblingNotification = {
          method: "thread/status/changed",
          params: { threadId: "thread-sibling", status: { type: "active" } },
        };
        harness.send(siblingNotification);
        await vi.waitFor(() =>
          expectDelivery(siblingNotifications, siblingNotification, { threadId: "thread-sibling" }),
        );
        expect(() =>
          router.reserveThread({ threadId: route.threadId, onNotification: vi.fn() }),
        ).not.toThrow();
      } finally {
        beforeNotifications.resolve();
        route.release();
        await binding?.catch(() => undefined);
      }
    },
  );
});
