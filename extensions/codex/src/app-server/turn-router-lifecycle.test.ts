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
import { settleInput } from "./turn-router.test-support.js";

describe("CodexAppServerTurnRouter lifecycle", () => {
  const createHarness = useRouterHarness();

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
          additionalDetails: null,
          misalignment: null,
        },
      },
      true,
    ],
    ["invalid items", { id: "turn-native", status: "completed", items: null }, false],
    ["missing status", { id: "turn-native", items: [] }, false],
    ["nonterminal status", { id: "turn-native", status: "inProgress", items: [] }, false],
  ])("validates native completion from %s", async (_label, turn, completed) => {
    if (completed) {
      vi.useFakeTimers();
    }
    const harness = createHarness("thread-native", "turn-native");
    const route = harness.reserve({ onNotification: vi.fn() });
    route.armTurn();
    await route.bindTurn("turn-native");
    const watch = harness.watch("turn-native", { timeoutMs: 1_000 });
    try {
      harness.notify("turn/completed", { threadId: route.threadId, turn });
      if (completed) {
        await vi.advanceTimersByTimeAsync(0);
      } else {
        await settleInput();
      }
      expect(route.completed).toBe(completed);
      expect(watch.state).toBe(completed ? "confirmed" : "pending");
      if (!completed) {
        harness.complete();
      }
      await expect(watch.completion).resolves.toBe(true);
      expect(route.completed).toBe(true);
    } finally {
      watch.cancel();
      route.release();
    }
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
    const settled = vi.fn();
    void watch.completion.then(settled);

    await vi.advanceTimersByTimeAsync(900);
    harness.turn("item/agentMessage/delta", { delta: "working" });
    await vi.advanceTimersByTimeAsync(101);
    await expect(watch.completion).resolves.toBe(false);
    expect(settled).toHaveBeenCalledWith(false);
  });

  it("settles detached native-turn watches on timeout and client close", async () => {
    const timeoutHarness = createHarness("thread-native-timeout");
    const timedOut = timeoutHarness.watch("turn-native-timeout", { timeoutMs: 1 });
    await expect(timedOut.completion).resolves.toBe(false);

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
