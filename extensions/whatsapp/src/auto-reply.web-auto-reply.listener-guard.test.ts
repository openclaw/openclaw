import "./test-helpers.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createScriptedWebListenerFactory,
  createWebInboundDeliverySpies,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  sendWebDirectInboundMessage,
} from "./auto-reply.test-harness.js";
import type { WebChannelStatus } from "./auto-reply/types.js";

installWebAutoReplyTestHomeHooks();

describe("WA listener guard", () => {
  installWebAutoReplyUnitTestHooks();

  let monitorWebChannel: typeof import("./auto-reply/monitor.js").monitorWebChannel;
  beforeAll(async () => {
    ({ monitorWebChannel } = await import("./auto-reply/monitor.js"));
  });

  it("marks status as disconnected immediately when watchdog triggers closeListener", async () => {
    vi.useFakeTimers();
    try {
      const statusUpdates: WebChannelStatus[] = [];
      const sleep = vi.fn(async () => {});
      const scripted = createScriptedWebListenerFactory();
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const controller = new AbortController();

      const run = monitorWebChannel(
        false,
        scripted.listenerFactory as never,
        true,
        async () => ({ text: "ok" }),
        runtime as never,
        controller.signal,
        {
          heartbeatSeconds: 60,
          messageTimeoutMs: 30,
          watchdogCheckMs: 5,
          reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 3, factor: 1.1, jitter: 0 },
          sleep,
          statusSink: (s: WebChannelStatus) => statusUpdates.push({ ...s }),
        },
      );

      await Promise.resolve();
      expect(scripted.getListenerCount()).toBe(1);
      await vi.waitFor(
        () => {
          expect(scripted.getOnMessage()).toBeTypeOf("function");
        },
        { timeout: 250, interval: 2 },
      );

      const spies = createWebInboundDeliverySpies();
      await sendWebDirectInboundMessage({
        onMessage: scripted.getOnMessage()!,
        body: "hi",
        from: "+1",
        to: "+2",
        id: "m1",
        spies,
      });

      // Advance past the watchdog timeout
      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();

      // The watchdog should have fired and immediately marked status as disconnected
      const disconnectUpdate = statusUpdates.find(
        (s) => !s.connected && s.lastError === "listener-null-watchdog-reconnect",
      );
      expect(disconnectUpdate).toBeDefined();
      expect(disconnectUpdate?.healthState).toBe("reconnecting");

      controller.abort();
      for (let i = 0; i < scripted.getListenerCount(); i++) {
        scripted.resolveClose(i, { status: 499, isLoggedOut: false });
      }
      await Promise.resolve();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires safety timer warning after 90s stuck reconnect", async () => {
    vi.useFakeTimers();
    const warnCalls: unknown[][] = [];
    const warnSpy = vi.fn((...args: unknown[]) => {
      warnCalls.push(args);
    });
    // Intercept getChildLogger to capture the reconnect logger's warn calls
    const runtimeEnv = await import("openclaw/plugin-sdk/runtime-env");
    const origGetChildLogger = runtimeEnv.getChildLogger;
    const getChildLoggerSpy = vi
      .spyOn(runtimeEnv, "getChildLogger")
      .mockImplementation((bindings?: Record<string, unknown>, opts?: unknown) => {
        const logger = origGetChildLogger(bindings, opts as never);
        if (bindings && bindings["module"] === "web-reconnect") {
          return new Proxy(logger, {
            get(target, prop, receiver) {
              if (prop === "warn") {
                return warnSpy;
              }
              return Reflect.get(target, prop, receiver);
            },
          });
        }
        return logger;
      });

    try {
      const sleep = vi.fn(async () => {});
      const scripted = createScriptedWebListenerFactory();
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const controller = new AbortController();

      const run = monitorWebChannel(
        false,
        scripted.listenerFactory as never,
        true,
        async () => ({ text: "ok" }),
        runtime as never,
        controller.signal,
        {
          heartbeatSeconds: 60,
          messageTimeoutMs: 30,
          watchdogCheckMs: 5,
          reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 3, factor: 1.1, jitter: 0 },
          sleep,
        },
      );

      await Promise.resolve();
      await vi.waitFor(
        () => {
          expect(scripted.getOnMessage()).toBeTypeOf("function");
        },
        { timeout: 250, interval: 2 },
      );

      const spies = createWebInboundDeliverySpies();
      await sendWebDirectInboundMessage({
        onMessage: scripted.getOnMessage()!,
        body: "hello",
        from: "+1",
        to: "+2",
        id: "m1",
        spies,
      });

      // Trigger watchdog → closeListener fires
      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();

      // Advance 90s — safety timer should fire and emit a warning
      await vi.advanceTimersByTimeAsync(90_000);
      await Promise.resolve();

      // Assert the reconnect logger's warn was called with the stuck-reconnect message
      const stuckWarn = warnCalls.find((args) =>
        args.some((a) => typeof a === "string" && a.includes("reconnect may be stuck")),
      );
      expect(stuckWarn).toBeDefined();

      controller.abort();
      for (let i = 0; i < scripted.getListenerCount(); i++) {
        scripted.resolveClose(i, { status: 499, isLoggedOut: false });
      }
      await Promise.resolve();
      await run;
    } finally {
      getChildLoggerSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
