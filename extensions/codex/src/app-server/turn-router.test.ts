import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "./protocol.js";
import {
  completedNotification,
  expectDelivery,
  unhandledToolResult,
  useRouterHarness,
} from "./turn-router.fixture.test-support.js";
import { settleInput, waitForResponse, type WireResponse } from "./turn-router.test-support.js";

const CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS = 660_000;

describe("CodexAppServerTurnRouter", () => {
  const createHarness = useRouterHarness();

  it("installs one request and notification handler per client", () => {
    const harness = createHarness();
    const methods = ["addNotificationHandler", "addRequestHandler", "addCloseHandler"] as const;
    const handlers = methods.map((method) => vi.spyOn(harness.client, method));
    const first = harness.router;
    expect(harness.router).toBe(first);
    expect(handlers.map((handler) => handler.mock.calls.length)).toEqual([1, 1, 1]);
  });

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

    const route = harness.reserve({ onNotification: notifications });
    route.armTurn();
    await route.bindTurn("turn-warnings");

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
    const route = harness.reserve({ onNotification: notifications });
    route.armTurn();
    await route.bindTurn("turn-current");
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
