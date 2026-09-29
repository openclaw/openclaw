import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import type { JsonObject } from "./protocol.js";
import { createClientHarness } from "./test-support.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";
import { settleInput, waitForResponse } from "./turn-router.test-support.js";

describe("CodexAppServerTurnRouter lifecycle", () => {
  const clients: CodexAppServerClient[] = [];

  afterEach(() => {
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createHarness(): ReturnType<typeof createClientHarness> {
    const harness = createClientHarness();
    clients.push(harness.client);
    return harness;
  }

  it.each<{ label: string; turn: JsonObject }>([
    { label: "invalid items", turn: { id: "turn-native", status: "completed", items: null } },
    { label: "missing status", turn: { id: "turn-native", items: [] } },
    { label: "nonterminal status", turn: { id: "turn-native", status: "inProgress", items: [] } },
  ])("does not publish native completion from $label", async ({ turn }) => {
    const harness = createHarness();
    const router = getCodexAppServerTurnRouter(harness.client);
    const route = router.reserveThread({ threadId: "thread-native", onNotification: vi.fn() });
    route.armTurn();
    await route.bindTurn("turn-native");
    const watch = router.watchNativeTurnCompletion({
      threadId: route.threadId,
      turnId: "turn-native",
      timeoutMs: 1_000,
    });
    try {
      harness.send({ method: "turn/completed", params: { threadId: route.threadId, turn } });
      await settleInput();
      expect(route.completed).toBe(false);
      expect(watch.state).toBe("pending");

      harness.send({
        method: "turn/completed",
        params: {
          threadId: route.threadId,
          turn: { id: "turn-native", status: "completed", items: [] },
        },
      });
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
      const harness = createHarness();
      const router = getCodexAppServerTurnRouter(harness.client);
      const route = router.reserveThread({
        threadId: "thread-native",
      });
      if (bound) {
        await route.activate({ onNotification: vi.fn() });
        route.armTurn();
        await route.bindTurn("turn-native");
      }
      harness.send({
        method: "turn/completed",
        params: {
          threadId: "thread-native",
          turn: { id: "turn-native", status: "completed", items: [] },
        },
      });
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
      harness.send({
        method: "turn/completed",
        params: {
          threadId: "thread-native",
          turn: { id: "turn-native", status: "completed", items: [] },
        },
      });

      harness.send({
        method: "turn/completed",
        params: {
          threadId: "thread-native",
          turn: { id: "turn-stale", status: "completed", items: [] },
        },
      });
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
    const harness = createHarness();
    const router = getCodexAppServerTurnRouter(harness.client);
    const route = router.reserveThread({
      threadId: "thread-native-active",
      onNotification: vi.fn(),
    });
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
    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-native-active",
        turn: { id: "turn-stale", status: "completed", items: [] },
      },
    });
    await settleInput();
    expect(route.observedNativeTurnId).toBe("turn-compact");

    const completed = router.watchNativeTurnCompletion({
      threadId: "thread-native-active",
      turnId: "turn-compact",
      timeoutMs: 100,
    });
    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-native-active",
        turn: { id: "turn-compact", status: "completed", items: [] },
      },
    });
    await expect(completed.completion).resolves.toBe(true);
    await route.cancelTurn();
  });

  it("settles exact native-completion watchers on completion, abort, and route release", async () => {
    const harness = createHarness();
    const router = getCodexAppServerTurnRouter(harness.client);
    const route = router.reserveThread({
      threadId: "thread-native-wait",
      onNotification: vi.fn(),
    });

    const completed = router.watchNativeTurnCompletion({
      threadId: "thread-native-wait",
      turnId: "turn-native",
      timeoutMs: 100,
    });
    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-native-wait",
        turn: { id: "turn-native", status: "completed", items: [] },
      },
    });
    await expect(completed.completion).resolves.toBe(true);

    const controller = new AbortController();
    const aborted = router.watchNativeTurnCompletion({
      threadId: "thread-native-wait",
      turnId: "turn-aborted",
      timeoutMs: 100,
      signal: controller.signal,
    });
    controller.abort("test");
    await expect(aborted.completion).resolves.toBe(false);
    const alreadyAborted = router.watchNativeTurnCompletion({
      threadId: "thread-native-wait",
      turnId: "turn-aborted",
      timeoutMs: 100,
      signal: controller.signal,
    });
    await expect(alreadyAborted.completion).resolves.toBe(false);

    const released = router.watchNativeTurnCompletion({
      threadId: "thread-native-wait",
      turnId: "turn-released",
      timeoutMs: 100,
      signal: route.signal,
    });
    route.release();
    await expect(released.completion).resolves.toBe(false);
  });

  it("watches one exact native turn without reserving its thread", async () => {
    const harness = createHarness();
    const router = getCodexAppServerTurnRouter(harness.client);
    const watch = router.watchNativeTurnCompletion({
      threadId: "thread-native-watch",
      turnId: "turn-target",
      timeoutMs: 100,
    });
    const settled = vi.fn();
    void watch.completion.then(settled);

    const route = router.reserveThread({
      threadId: "thread-native-watch",
      onNotification: vi.fn(),
    });
    route.release();
    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-native-watch",
        turn: { id: "turn-other", status: "completed", items: [] },
      },
    });
    await settleInput();
    expect(settled).not.toHaveBeenCalled();

    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-native-watch",
        turn: { id: "turn-target", status: "completed", items: [] },
      },
    });
    await expect(watch.completion).resolves.toBe(true);
  });

  it("waits for completed notification after an exact non-retry error", async () => {
    const harness = createHarness();
    const watch = getCodexAppServerTurnRouter(harness.client).watchNativeTurnCompletion({
      threadId: "thread-native-error",
      turnId: "turn-native-error",
      timeoutMs: 100,
    });
    const settled = vi.fn();
    void watch.completion.then(settled);

    harness.send({
      method: "error",
      params: {
        threadId: "thread-native-error",
        turnId: "turn-native-error",
        error: { message: "retrying" },
        willRetry: true,
      },
    });
    await settleInput();
    expect(settled).not.toHaveBeenCalled();

    harness.send({
      method: "error",
      params: {
        threadId: "thread-native-error",
        turnId: "turn-native-error",
        error: { message: "review setup failed" },
        willRetry: false,
      },
    });
    await settleInput();
    expect(settled).not.toHaveBeenCalled();

    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-native-error",
        turn: { id: "turn-native-error", status: "failed", items: [] },
      },
    });
    await expect(watch.completion).resolves.toBe(true);
  });

  it("keeps a hard completion deadline despite exact-turn progress", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const watch = getCodexAppServerTurnRouter(harness.client).watchNativeTurnCompletion({
      threadId: "thread-native-progress",
      turnId: "turn-native-progress",
      timeoutMs: 1_000,
    });
    const settled = vi.fn();
    void watch.completion.then(settled);

    await vi.advanceTimersByTimeAsync(900);
    harness.send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-native-progress",
        turnId: "turn-native-progress",
        delta: "working",
      },
    });
    await vi.advanceTimersByTimeAsync(101);
    await expect(watch.completion).resolves.toBe(false);
    expect(settled).toHaveBeenCalledWith(false);
  });

  it("cancels a detached native-turn completion watch", async () => {
    const harness = createHarness();
    const watch = getCodexAppServerTurnRouter(harness.client).watchNativeTurnCompletion({
      threadId: "thread-native-cancel",
      turnId: "turn-native-cancel",
      timeoutMs: 100,
    });

    watch.cancel();

    await expect(watch.completion).resolves.toBe(false);
  });

  it("settles detached native-turn watches on timeout and client close", async () => {
    const timeoutHarness = createHarness();
    const timedOut = getCodexAppServerTurnRouter(timeoutHarness.client).watchNativeTurnCompletion({
      threadId: "thread-native-timeout",
      turnId: "turn-native-timeout",
      timeoutMs: 1,
    });
    await expect(timedOut.completion).resolves.toBe(false);

    const closeHarness = createHarness();
    const closed = getCodexAppServerTurnRouter(closeHarness.client).watchNativeTurnCompletion({
      threadId: "thread-native-close",
      turnId: "turn-native-close",
      timeoutMs: 100,
    });
    closeHarness.client.close();
    await expect(closed.completion).resolves.toBe(false);
  });

  it("releases pending requests and removes routes on cleanup", async () => {
    const harness = createHarness();
    const router = getCodexAppServerTurnRouter(harness.client);
    const notificationHandler = vi.fn();
    const requestHandler = vi.fn(() => ({ decision: "accept" }));
    const route = router.reserveThread({
      threadId: "thread-release",
      onNotification: notificationHandler,
      onRequest: requestHandler,
    });
    route.armTurn();
    harness.send({
      id: "request-release",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-release",
        turnId: "turn-release",
        itemId: "item-1",
      },
    });
    await settleInput();

    route.release();
    harness.send({
      method: "item/started",
      params: { threadId: "thread-release", turnId: "turn-release" },
    });

    expect(await waitForResponse(harness, "request-release")).toEqual({
      id: "request-release",
      result: { decision: "decline" },
    });
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

    expect(await waitForResponse(harness, "request-active")).toEqual({
      id: "request-active",
      result: { decision: "decline" },
    });
    expect(await waitForResponse(harness, "request-active-reject")).toEqual({
      id: "request-active-reject",
      result: { decision: "decline" },
    });

    const closingRoute = router.reserveThread({
      threadId: "thread-close",
      onRequest: activeHandler,
    });
    closingRoute.armTurn();
    await closingRoute.bindTurn("turn-close");
    harness.send({
      id: "request-close",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-close", turnId: "turn-close", itemId: "item-4" },
    });
    await vi.waitFor(() => expect(activeHandler).toHaveBeenCalledTimes(3));
    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-close",
        turn: { id: "turn-close", status: "completed", items: [] },
      },
    });
    harness.process.stderr.write("fatal transport detail\n");
    harness.process.emit("exit", 17, "SIGTERM");

    expect(closingRoute.completed).toBe(true);
    await expect(closingRoute.bindTurn("turn-close")).rejects.toThrow("turn router closed");
    expect(activeHandler.mock.calls[2]?.[2].aborted).toBe(true);
    expect(closingRoute.signal.aborted).toBe(true);
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

  it.each(["stale completion", "explicit release", "overflow"] as const)(
    "does not drain a closed route after %s",
    async (reason) => {
      vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
      const harness = createHarness();
      const notifications = vi.fn();
      const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
        threadId: "thread-closed",
        onNotification: notifications,
      });
      route.armTurn();
      harness.send({
        method: "turn/completed",
        params: {
          threadId: route.threadId,
          turn: {
            id: reason === "stale completion" ? "turn-stale" : "turn-current",
            status: "completed",
            items: [],
          },
        },
      });
      if (reason === "explicit release") {
        route.release();
      } else if (reason === "overflow") {
        for (let index = 0; index < 256; index += 1) {
          harness.send({
            method: "item/started",
            params: { threadId: route.threadId, turnId: "turn-current" },
          });
        }
      }
      harness.client.close();

      await expect(
        route.bindTurn("turn-current", { completed: reason !== "stale completion" }),
      ).rejects.toThrow(
        reason === "stale completion"
          ? "turn router closed"
          : reason === "explicit release"
            ? "thread route is released"
            : "pre-bind notification buffer exceeded",
      );
      expect(route.signal.aborted).toBe(true);
      expect(notifications).not.toHaveBeenCalled();
    },
  );

  it("releases dormant waiters and aborts the reservation", async () => {
    const harness = createHarness();
    const router = getCodexAppServerTurnRouter(harness.client);
    const route = router.reserveThread({ threadId: "thread-dormant-release" });
    harness.send({
      id: "request-dormant-release",
      method: "item/tool/call",
      params: { threadId: "thread-dormant-release", turnId: "turn-1" },
    });
    await settleInput();

    route.release();

    expect(route.signal.aborted).toBe(true);
    expect(route.signal.reason).toEqual(new Error("codex app-server thread route is released"));
    await expect(route.activate({ onRequest: vi.fn() })).rejects.toThrow(
      "thread route is released",
    );
    await expect(route.bindTurn("turn-1")).rejects.toThrow("thread route is released");
    expect(await waitForResponse(harness, "request-dormant-release")).toEqual({
      id: "request-dormant-release",
      result: {
        contentItems: [
          {
            type: "inputText",
            text: "OpenClaw did not register a handler for this app-server tool call.",
          },
        ],
        success: false,
      },
    });
  });

  it("drains an exact terminal receipt after physical closure releases a paused route", async () => {
    const harness = createHarness();
    const notifications = vi.fn();
    const receipts = vi.fn();
    const beforeNotifications = createDeferred<void>();
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-closed-paused",
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
    const completed = {
      method: "turn/completed",
      params: {
        threadId: route.threadId,
        turn: { id: "turn-current", status: "completed", items: [] },
      },
    };
    try {
      harness.send(completed);
      harness.process.emit("exit", 0, null);
      await route.drain();
      await settleInput();

      expect(route.completed).toBe(true);
      expect(route.signal.aborted).toBe(true);
      expect(receipts.mock.calls.map(([notification]) => notification)).toEqual([
        started,
        completed,
      ]);
      expect(notifications).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();

      beforeNotifications.resolve();
      await binding;
      expect(notifications.mock.calls.map(([notification]) => notification)).toEqual([
        started,
        completed,
      ]);
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
      const harness = createHarness();
      const router = getCodexAppServerTurnRouter(harness.client);
      const notifications = vi.fn();
      const requests = vi.fn(() => ({ decision: "accept" }));
      const siblingNotifications = vi.fn();
      router.reserveThread({ threadId: "thread-sibling", onNotification: siblingNotifications });
      const route = router.reserveThread({
        threadId: "thread-overflow",
        onNotification: notifications,
        onRequest: requests,
      });
      route.armTurn();
      const beforeNotifications = createDeferred<void>();
      const binding = paused
        ? route.bindTurn("turn-overflow", { beforeNotifications: beforeNotifications.promise })
        : undefined;
      void binding?.catch(() => undefined);
      harness.send({
        id: "request-overflow",
        method: "item/commandExecution/requestApproval",
        params: { threadId: route.threadId, turnId: "turn-overflow", itemId: "item-overflow" },
      });
      for (let index = 0; index < 256; index += 1) {
        harness.send({
          method: "item/started",
          params: { threadId: "thread-overflow", turnId: "turn-overflow" },
        });
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
        expect(await waitForResponse(harness, "request-overflow")).toEqual({
          id: "request-overflow",
          result: { decision: "decline" },
        });
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
          expect(siblingNotifications).toHaveBeenCalledWith(siblingNotification, {
            threadId: "thread-sibling",
          }),
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
