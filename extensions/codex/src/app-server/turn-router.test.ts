import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "./protocol.js";
import {
  completedNotification,
  expectDelivery,
  unhandledToolResult,
  useRouterHarness,
} from "./turn-router.fixture.test-support.js";
import { settleInput, waitForResponse } from "./turn-router.test-support.js";

const CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS = 660_000;
const createHarness = useRouterHarness();
const accept = { decision: "accept" };
const decline = { decision: "decline" };
const toolResult = { success: true, contentItems: [] };

function quietWarnings() {
  return vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
}

function notificationRecorder() {
  const received: string[] = [];
  const delivered: string[] = [];
  return {
    received,
    delivered,
    onNotificationReceived: ({ method }: { method: string }) => {
      received.push(method);
    },
    onNotification: ({ method }: { method: string }) => {
      delivered.push(method);
    },
  };
}

function blockedNotifications() {
  const pending = createDeferred<void>();
  const events: string[] = [];
  const recorder = notificationRecorder();
  return {
    ...recorder,
    pending,
    events,
    onNotification: async ({ method }: { method: string }) => {
      events.push(`${method}:start`);
      if (method === "item/started") {
        await pending.promise;
      }
      events.push(`${method}:end`);
    },
  };
}

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
          const notifications: Array<[string | undefined, boolean]> = [];
          const receipts: Array<[string | undefined, boolean]> = [];
          const handlers = {
            async onRequest(this: unknown) {
              await Promise.resolve();
              return { owner: context.getStore() ?? "missing", unbound: this === undefined };
            },
            async onNotification(this: unknown) {
              await Promise.resolve();
              notifications.push([context.getStore(), this === undefined]);
            },
            onNotificationReceived(this: unknown) {
              receipts.push([context.getStore(), this === originalHandlers]);
            },
          };
          const options = { threadId: "shared-thread", ...handlers };
          const originalHandlers: object = registration === "reserve" ? options : handlers;
          const route = context.run(registration === "reserve" ? owner : "reservation", () =>
            router.reserveThread(
              registration === "reserve" ? options : { threadId: "shared-thread" },
            ),
          );
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
            });
          });
          expect(await waitForResponse(harness, owner)).toMatchObject({
            result: { owner, unbound: true },
          });
          await route.drain();
          expect(notifications).toEqual([[owner, true]]);
          expect(receipts).toEqual([[owner, true]]);
          route.release();
        }
      } finally {
        transport.emitDestroy();
        context.disable();
      }
    },
  );

  it("delivers global startup warnings to the next reserved thread", async () => {
    const harness = createHarness();
    const warning = { method: "configWarning", params: { summary: "Startup warning" } };
    harness.send(warning);
    const notifications = vi.fn();
    await bindRoute(harness, "turn-1", { onNotification: notifications });
    await vi.waitFor(() => expectDelivery(notifications, warning, { threadId: "thread-1" }, {}));
  });

  it("does not dispatch a request that times out before route activation", async () => {
    vi.useFakeTimers();
    quietWarnings();
    const harness = createHarness("thread-late", "turn-late");
    const requestHandler = vi.fn(() => ({ executed: true }));
    const route = harness.reserve();

    harness.call("request-late", "item/tool/call", { tool: "message" });
    await vi.advanceTimersByTimeAsync(CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS);
    expect(await waitForResponse(harness, "request-late")).toMatchObject({
      result: { success: false },
    });

    await route.activate({ onRequest: requestHandler });

    expect(requestHandler).not.toHaveBeenCalled();
  });

  it("keeps execution budgets with the matching thread owner", async () => {
    vi.useFakeTimers();
    quietWarnings();
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
    quietWarnings();
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
    const warn = quietWarnings();
    const harness = createHarness("thread-2", "turn-2");
    const first = notificationRecorder();
    const second = notificationRecorder();
    const secondHandler = vi.fn(second.onNotification);
    for (const [number, recorder] of [
      [1, first],
      [2, second],
    ] as const) {
      const route = harness.router.reserveThread({
        threadId: `thread-${number}`,
        ...recorder,
        onNotification: number === 2 ? secondHandler : recorder.onNotification,
        onRequest: () => ({ owner: number }),
      });
      route.armTurn();
      await route.bindTurn(`turn-${number}`);
    }

    harness.turn("item/agentMessage/delta", { delta: "right" });
    harness.complete();
    harness.turn("item/agentMessage/delta", { turnId: "turn-stale", delta: "wrong" });
    harness.turn("item/agentMessage/delta", { turnId: "turn-stale", delta: "wrong" });
    harness.call("request-2", "item/tool/call", { tool: "second" });
    harness.request("request-1", "item/tool/call", {
      threadId: "thread-1",
      turnId: "turn-1",
      tool: "first",
    });

    await harness.expectResponse("request-1", { owner: 1 });
    await harness.expectResponse("request-2", { owner: 2 });
    expect(first.delivered).toEqual([]);
    expect(second.delivered).toEqual(["item/agentMessage/delta", "turn/completed"]);
    expect(warn).toHaveBeenCalledOnce();
    expect(secondHandler.mock.lastCall).toMatchObject([
      { completedTurn: { id: "turn-2" } },
      { threadId: "thread-2", turnId: "turn-2" },
    ]);
  });

  it.each([false, true])(
    "drains exact paused notifications (physical close: %s)",
    async (closed) => {
      const harness = createHarness();
      const recorder = blockedNotifications();
      const { events, received, pending } = recorder;
      const beforeNotifications = createDeferred<void>();
      const route = harness.reserve({
        ...recorder,
        onRequest: () => {
          events.push("request");
          return toolResult;
        },
      });
      route.armTurn();
      harness.notify("thread/started", { thread: { id: "thread-1" } });
      harness.turn("item/started");
      harness.turn("item/completed", { turnId: "turn-stale" });
      if (!closed) {
        harness.call("request", "item/tool/call", { tool: "message" });
      }

      const binding = route.bindTurn("turn-1", {
        beforeNotifications: beforeNotifications.promise,
      });
      const drained = vi.fn();
      const draining = route.drain().then(drained);
      const bound = vi.fn();
      void binding.then(bound, bound);
      try {
        harness.notify("configWarning", { message: "global warning" });
        harness.send(completedNotification(route.threadId, "turn-stale"));
        harness.complete();
        if (closed) {
          harness.process.emit("exit", 0, null);
          await draining;
        }
        await settleInput();
        const expectedReceipts = [
          "thread/started",
          "item/started",
          "configWarning",
          "turn/completed",
        ];
        expect(received).toEqual(expectedReceipts);
        expect(route.completed).toBe(true);
        expect(events).toEqual([]);
        expect(bound).not.toHaveBeenCalled();
        expect(route.signal.aborted).toBe(closed);
        expect(drained).toHaveBeenCalledTimes(closed ? 1 : 0);
        expect(harness.writes).toEqual([]);

        beforeNotifications.resolve();
        await vi.waitFor(() =>
          expect(events).toEqual([
            "thread/started:start",
            "thread/started:end",
            "item/started:start",
          ]),
        );
        expect(bound).not.toHaveBeenCalled();
        expect(drained).toHaveBeenCalledTimes(closed ? 1 : 0);
        expect(harness.writes).toEqual([]);
        pending.resolve();
        await binding;
        await draining;
        if (!closed) {
          await harness.expectResponse("request", toolResult);
        }
        expect(received).toEqual(expectedReceipts);
        expect(events).toEqual([
          ...expectedReceipts.flatMap((method) => [`${method}:start`, `${method}:end`]),
          ...(!closed ? ["request"] : []),
        ]);
      } finally {
        beforeNotifications.resolve();
        pending.resolve();
        route.release();
        await binding.catch(() => undefined);
        await draining;
      }
    },
  );

  it("drain resolves after release while a handler is blocked and routing waiters are pending", async () => {
    const harness = createHarness();
    const handler = vi.fn(() => new Promise<void>(() => {}));
    const route = harness.reserve({
      onNotification: handler,
      onRequest: () => accept,
    });
    route.armTurn();
    harness.turn("item/started");
    harness.call("request", "item/commandExecution/requestApproval");
    const binding = expect(route.bindTurn("turn-1")).rejects.toThrow("thread route is released");
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    const draining = route.drain();
    route.release();
    await Promise.all([draining, binding]);
    await harness.expectResponse("request", decline);
  });

  it("receives and drains open-route notifications while an armed route waits", async () => {
    const harness = createHarness();
    const router = harness.router;
    const live = blockedNotifications();
    const { events, pending } = live;
    const turnHandler = vi.fn();
    const liveRoute = router.reserveThread({
      threadId: "thread-live",
      ...live,
      onNotificationReceived: ({ method }) => {
        events.push(`${method}:received`);
      },
    });
    const turnRoute = router.reserveThread({
      threadId: "thread-buffered",
      onNotification: turnHandler,
    });
    turnRoute.armTurn();

    const bufferedNotification = {
      method: "item/started",
      params: { threadId: "thread-buffered", turnId: "turn-buffered" },
    };
    for (const method of ["item/started", "item/completed"]) {
      harness.notify(method, { threadId: "thread-live" });
    }
    harness.send(bufferedNotification);
    await vi.waitFor(() => expect(events).toContain("item/started:start"));
    expect(events).toEqual([
      "item/started:received",
      "item/completed:received",
      "item/started:start",
    ]);
    expect(turnHandler).not.toHaveBeenCalled();
    pending.resolve();
    await liveRoute.drain();
    expect(events.slice(3)).toEqual([
      "item/started:end",
      "item/completed:start",
      "item/completed:end",
    ]);
    await turnRoute.bindTurn("turn-buffered");
    expect(turnHandler).toHaveBeenCalledOnce();
  });

  it("holds dormant traffic until one-shot activation", async () => {
    const harness = createHarness();
    const recorder = notificationRecorder();
    const route = harness.reserve();
    route.armTurn();
    harness.turn("thread/status/changed", { status: { type: "active" } });
    harness.turn("item/started");
    harness.call("thread", "mcpServer/elicitation/request", { turnId: null });
    harness.call("turn", "item/tool/call");
    harness.call("stale", "item/tool/call", { turnId: "turn-stale" });
    await settleInput();
    expect(harness.writes).toEqual([]);
    expect(route.signal.aborted).toBe(false);
    await expect(route.bindTurn("turn-1")).rejects.toThrow(
      "thread route must be activated before binding a turn",
    );
    await expect(route.activate({})).rejects.toThrow(
      "thread route requires a notification or request handler",
    );
    await route.activate({
      ...recorder,
      onRequest: (request) =>
        request.method === "item/tool/call" ? toolResult : { action: "accept" },
    });
    expect(recorder.delivered).toEqual([]);
    expect(harness.writes.map((line) => JSON.parse(line))).not.toContainEqual(
      expect.objectContaining({ id: "turn" }),
    );
    await route.bindTurn("turn-1");
    expect(recorder.delivered).toEqual(["thread/status/changed", "item/started"]);
    await harness.expectResponse("thread", { action: "accept" });
    await harness.expectResponse("turn", toolResult);
    await harness.expectResponse("stale", unhandledToolResult);
    await expect(route.activate({ onRequest: vi.fn() })).rejects.toThrow(
      "thread route already activated",
    );
  });

  it("keeps resumed-turn requests open until a new turn is armed", async () => {
    const harness = createHarness();
    const handler = vi.fn(() => undefined);
    const notificationHandler = vi.fn();
    const route = harness.reserve({ onRequest: handler, onNotification: notificationHandler });

    harness.call("old", "item/commandExecution/requestApproval");
    await harness.expectResponse("old", decline);
    expect(handler).toHaveBeenCalledTimes(1);

    route.armTurn();
    harness.call("next", "item/commandExecution/requestApproval", {
      turnId: "turn-next",
    });
    const earlyError = {
      method: "error",
      params: { threadId: "thread-1", message: "turn start failed" },
    };
    harness.send(earlyError);
    await settleInput();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(notificationHandler).not.toHaveBeenCalled();

    await route.cancelTurn();
    expectDelivery(notificationHandler, earlyError, { threadId: "thread-1" });
    await harness.expectResponse("next", decline);
    expect(handler).toHaveBeenCalledTimes(2);

    route.armTurn();
    await route.bindTurn("turn-final");
    route.release();
  });
});

describe("CodexAppServerTurnRouter lifecycle", () => {
  it.each<[boolean, JsonObject]>([
    [
      true,
      { status: "interrupted", error: { message: "Denied", codexErrorInfo: "tooManyDenials" } },
    ],
    [false, {}],
  ])("validates native completion (terminal: %s)", async (completed, fields) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createHarness();
    const route = await bindRoute(harness, "turn-1");
    const watch = harness.watch("turn-1", { timeoutMs: 1_000 });
    harness.notify("turn/completed", {
      threadId: route.threadId,
      turn: { id: "turn-1", items: [], ...fields },
    });
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
      const harness = createHarness();
      const route = bound ? await bindRoute(harness, "turn-1") : harness.reserve();
      harness.complete();
      await settleInput();
      if (!bound) {
        await route.activate({ onNotification: vi.fn() });
      }
      expect(route.observedNativeTurnId).toBe("turn-1");
      const completion = (turnId = "turn-1") => harness.watch(turnId, { timeoutMs: 1 }).completion;
      await expect(completion()).resolves.toBe(true);
      await expect(completion()).resolves.toBe(true);
      harness.turn("turn/started", { turn: { id: "turn-1", status: "inProgress" } });
      await settleInput();
      await expect(completion()).resolves.toBe(false);
      harness.complete();
      harness.complete("turn-stale");
      await settleInput();
      if (bound) {
        route.release();
        const nextRoute = harness.reserve();
        await expect(completion()).resolves.toBe(false);
        nextRoute.release();
      } else {
        route.armTurn();
        expect(route.observedNativeTurnId).toBeUndefined();
        await expect(completion("turn-stale")).resolves.toBe(false);
        await route.cancelTurn();
      }
    },
  );

  it("keeps an observed active native turn exact across arm and stale completion", async () => {
    const harness = createHarness();
    const route = harness.reserve({ onNotification: vi.fn() });
    harness.turn("turn/started", { turn: { id: "turn-compact", status: "inProgress" } });
    await settleInput();

    route.armTurn();
    expect(route.observedNativeTurnId).toBe("turn-compact");
    harness.complete("turn-stale");
    await settleInput();
    expect(route.observedNativeTurnId).toBe("turn-compact");

    const completed = harness.watch("turn-compact");
    harness.complete("turn-compact");
    await expect(completed.completion).resolves.toBe(true);
    await route.cancelTurn();
  });

  it("settles pending and already-aborted native-turn watches", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const signal = controller.signal;
    const watch = harness.watch("turn-1", { signal });
    controller.abort();
    await expect(watch.completion).resolves.toBe(false);
    await expect(harness.watch("turn-1", { signal }).completion).resolves.toBe(false);
  });

  it("settles detached native-turn watches on client close", async () => {
    const harness = createHarness();
    const completion = harness.watch("turn-1").completion;
    harness.client.close();
    await expect(completion).resolves.toBe(false);
  });

  it("releases pending requests and removes routes on cleanup", async () => {
    const harness = createHarness();
    const router = harness.router;
    const notificationHandler = vi.fn();
    const requestHandler = vi.fn(() => accept);
    const route = harness.reserve({
      onNotification: notificationHandler,
      onRequest: requestHandler,
    });
    route.armTurn();
    harness.call("queued", "item/commandExecution/requestApproval");
    await settleInput();

    route.release();
    harness.turn("item/started");

    await harness.expectResponse("queued", decline);
    expect(notificationHandler).not.toHaveBeenCalled();
    expect(requestHandler).not.toHaveBeenCalled();

    const signals: AbortSignal[] = [];
    const activeRoute = await bindRoute(harness, "turn-1", {
      onRequest: (request, _scope, signal) =>
        new Promise<typeof accept>((resolve, reject) => {
          signals.push(signal);
          signal.addEventListener(
            "abort",
            () => {
              if (request.id === "reject") {
                reject(new Error("stale request failure"));
              } else {
                resolve(accept);
              }
            },
            { once: true },
          );
        }),
    });
    for (const id of ["resolve", "reject"]) {
      harness.call(id, "item/commandExecution/requestApproval");
    }
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
    activeRoute.release();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    for (const id of ["resolve", "reject"]) {
      await harness.expectResponse(id, decline);
    }

    const closingRoute = await bindRoute(harness, "turn-1", {
      onRequest: (_request, _scope, signal) => {
        signals.push(signal);
        return new Promise<never>(() => {});
      },
    });
    harness.call("close", "item/commandExecution/requestApproval");
    await vi.waitFor(() => expect(signals).toHaveLength(3));
    harness.complete();
    harness.process.emit("exit", 17, "SIGTERM");

    expect(closingRoute).toMatchObject({ completed: true, signal: { aborted: true } });
    await expect(closingRoute.bindTurn("turn-1")).rejects.toThrow("turn router closed");
    expect(signals[2]?.aborted).toBe(true);
    expect(closingRoute.signal.reason.cause).toBe(harness.client.getCloseError());
    expect(() =>
      router.reserveThread({ threadId: "thread-late", onRequest: requestHandler }),
    ).toThrow("turn router is closed");
  });

  it("does not drain a closed route after a stale completion", async () => {
    quietWarnings();
    const harness = createHarness();
    const notifications = vi.fn();
    const route = harness.reserve({ onNotification: notifications });
    route.armTurn();
    harness.complete("turn-stale");
    harness.client.close();
    await expect(route.bindTurn("turn-1")).rejects.toThrow("turn router closed");
    expect(route.signal.aborted).toBe(true);
    expect(notifications).not.toHaveBeenCalled();
  });

  it("releases dormant waiters and aborts the reservation", async () => {
    const harness = createHarness();
    const route = harness.reserve();
    route.armTurn();
    harness.call("request", "item/tool/call");
    harness.complete();
    await settleInput();

    route.release();
    await harness.expectResponse("request", unhandledToolResult);
    harness.client.close();

    expect(route.signal.aborted).toBe(true);
    expect(route.signal.reason).toEqual(new Error("codex app-server thread route is released"));
    await expect(route.activate({ onRequest: vi.fn() })).rejects.toThrow(
      "thread route is released",
    );
    await expect(route.bindTurn("turn-1", { completed: true })).rejects.toThrow(
      "thread route is released",
    );
  });

  it.each([
    { label: "pre-bind notifications", paused: false, overflowMethod: "item/started" },
    { label: "paused notifications", paused: true, overflowMethod: "item/started" },
    { label: "paused global warnings", paused: true, overflowMethod: "configWarning" },
  ])(
    "fails and removes a route when its buffer is full of $label",
    async ({ paused, overflowMethod }) => {
      quietWarnings();
      const harness = createHarness();
      const router = harness.router;
      const notifications = vi.fn();
      const requests = vi.fn(() => accept);
      const sibling = notificationRecorder();
      router.reserveThread({ threadId: "sibling", ...sibling });
      const route = harness.reserve({ onNotification: notifications, onRequest: requests });
      route.armTurn();
      const beforeNotifications = createDeferred<void>();
      const binding = paused
        ? route.bindTurn("turn-1", { beforeNotifications: beforeNotifications.promise })
        : undefined;
      void binding?.catch(() => undefined);
      harness.call("overflow", "item/commandExecution/requestApproval");
      for (let index = 0; index < 256; index += 1) {
        harness.turn("item/started");
      }
      await settleInput();
      try {
        expect(route.signal.aborted).toBe(false);
        if (overflowMethod === "configWarning") {
          harness.notify(overflowMethod, { message: "overflow" });
        } else {
          harness.turn(overflowMethod);
        }
        await settleInput();

        expect(route.signal.aborted).toBe(true);
        await expect(binding ?? route.bindTurn("turn-1")).rejects.toThrow(
          "pre-bind notification buffer exceeded 256 entries",
        );
        await harness.expectResponse("overflow", decline);
        beforeNotifications.resolve();
        await settleInput();
        expect(notifications).not.toHaveBeenCalled();
        expect(requests).not.toHaveBeenCalled();

        harness.notify("thread/status/changed", {
          threadId: "sibling",
          status: { type: "active" },
        });
        await vi.waitFor(() => expect(sibling.delivered).toEqual(["thread/status/changed"]));
      } finally {
        beforeNotifications.resolve();
        route.release();
        await binding?.catch(() => undefined);
      }
    },
  );
});
