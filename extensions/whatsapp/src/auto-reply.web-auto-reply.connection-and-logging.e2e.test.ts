import "./test-helpers.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { setGatewaySigusr1RestartPolicy } from "../../../src/infra/restart.js";
import { setLoggerOverride } from "../../../src/logging.js";
import { withEnvAsync } from "../../../src/test-utils/env.js";
import { escapeRegExp, formatEnvelopeTimestamp } from "../../../test/helpers/envelope-timestamp.js";
import {
  createMockWebListener,
  createWebListenerFactoryCapture,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  makeSessionStore,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";
import type { WebInboundMessage } from "./inbound.js";

installWebAutoReplyTestHomeHooks();

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function startMonitorWebChannel(params: {
  monitorWebChannelFn: (...args: unknown[]) => Promise<unknown>;
  listenerFactory: unknown;
  sleep: ReturnType<typeof vi.fn>;
  signal?: AbortSignal;
  heartbeatSeconds?: number;
  messageTimeoutMs?: number;
  watchdogCheckMs?: number;
  reconnect?: { initialMs: number; maxMs: number; maxAttempts: number; factor: number };
}) {
  const runtime = createRuntime();
  const controller = new AbortController();
  const run = params.monitorWebChannelFn(
    false,
    params.listenerFactory as never,
    true,
    async () => ({ text: "ok" }),
    runtime as never,
    params.signal ?? controller.signal,
    {
      heartbeatSeconds: params.heartbeatSeconds ?? 1,
      messageTimeoutMs: params.messageTimeoutMs,
      watchdogCheckMs: params.watchdogCheckMs,
      reconnect: params.reconnect ?? { initialMs: 10, maxMs: 10, maxAttempts: 3, factor: 1.1 },
      sleep: params.sleep,
    },
  );

  return { runtime, controller, run };
}

function makeInboundMessage(params: {
  body: string;
  from: string;
  to: string;
  id?: string;
  timestamp?: number;
  sendComposing: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  sendMedia: ReturnType<typeof vi.fn>;
}): WebInboundMessage {
  return {
    body: params.body,
    from: params.from,
    to: params.to,
    id: params.id,
    timestamp: params.timestamp,
    conversationId: params.from,
    accountId: "default",
    chatType: "direct",
    chatId: params.from,
    sendComposing: params.sendComposing as unknown as WebInboundMessage["sendComposing"],
    reply: params.reply as unknown as WebInboundMessage["reply"],
    sendMedia: params.sendMedia as unknown as WebInboundMessage["sendMedia"],
  };
}

describe("web auto-reply connection", () => {
  installWebAutoReplyUnitTestHooks();

  let monitorWebChannel: typeof import("./auto-reply.js").monitorWebChannel;
  beforeAll(async () => {
    ({ monitorWebChannel } = await import("./auto-reply.js"));
  });

  it("handles helper envelope timestamps with trimmed timezones (regression)", () => {
    const d = new Date("2025-01-01T00:00:00.000Z");
    expect(() => formatEnvelopeTimestamp(d, " America/Los_Angeles ")).not.toThrow();
  });

  it("handles reconnect progress and max-attempt stop behavior", async () => {
    for (const scenario of [
      {
        reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 3, factor: 1.1 },
        expectedCallsAfterFirstClose: 2,
        closeTwiceAndFinish: false,
        expectedError: "Retry 1",
      },
      {
        reconnect: { initialMs: 5, maxMs: 5, maxAttempts: 2, factor: 1.1 },
        expectedCallsAfterFirstClose: 2,
        closeTwiceAndFinish: true,
        expectedError: "max attempts reached",
      },
    ]) {
      const closeResolvers: Array<() => void> = [];
      const sleep = vi.fn(async () => {});
      const listenerFactory = vi.fn(async () => {
        const onClose = new Promise<void>((res) => {
          closeResolvers.push(res);
        });
        return { close: vi.fn(), onClose };
      });
      const { runtime, controller, run } = startMonitorWebChannel({
        monitorWebChannelFn: monitorWebChannel as never,
        listenerFactory,
        sleep,
        reconnect: scenario.reconnect,
      });

      await Promise.resolve();
      expect(listenerFactory).toHaveBeenCalledTimes(1);

      closeResolvers.shift()?.();
      await vi.waitFor(
        () => {
          expect(listenerFactory).toHaveBeenCalledTimes(scenario.expectedCallsAfterFirstClose);
        },
        { timeout: 250, interval: 2 },
      );

      if (scenario.closeTwiceAndFinish) {
        closeResolvers.shift()?.();
        await run;
      } else {
        controller.abort();
        closeResolvers.shift()?.();
        await Promise.resolve();
        await run;
      }

      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(scenario.expectedError));
    }
  });

  it("treats status 440 as non-retryable and stops without retrying", async () => {
    const closeResolvers: Array<(reason?: unknown) => void> = [];
    const sleep = vi.fn(async () => {});
    const listenerFactory = vi.fn(async () => {
      const onClose = new Promise<unknown>((res) => {
        closeResolvers.push(res);
      });
      return { close: vi.fn(), onClose };
    });
    const { runtime, controller, run } = startMonitorWebChannel({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory,
      sleep,
      reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 3, factor: 1.1 },
    });

    await Promise.resolve();
    expect(listenerFactory).toHaveBeenCalledTimes(1);
    closeResolvers.shift()?.({
      status: 440,
      isLoggedOut: false,
      error: "Unknown Stream Errored (conflict)",
    });

    const completedQuickly = await Promise.race([
      run.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 60)),
    ]);

    if (!completedQuickly) {
      await vi.waitFor(
        () => {
          expect(listenerFactory).toHaveBeenCalledTimes(2);
        },
        { timeout: 250, interval: 2 },
      );
      controller.abort();
      closeResolvers[1]?.({ status: 499, isLoggedOut: false, error: "aborted" });
      await run;
    }

    expect(completedQuickly).toBe(true);
    expect(listenerFactory).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("status 440"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("session conflict"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Stopping web monitoring"));
  });

  it("gracefully closes the active listener on SIGUSR1 restart without reconnecting", async () => {
    const sleep = vi.fn(async () => {});
    let resolveClose: (reason?: unknown) => void = () => {};
    const close = vi.fn(async () => undefined);
    const signalClose = vi.fn((reason?: unknown) => resolveClose(reason));
    const listenerFactory = vi.fn(async () => {
      const onClose = new Promise<unknown>((res) => {
        resolveClose = res;
      });
      return { close, onClose, signalClose };
    });
    const { run } = startMonitorWebChannel({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory,
      sleep,
      heartbeatSeconds: 60,
    });

    await Promise.resolve();
    expect(listenerFactory).toHaveBeenCalledTimes(1);

    setGatewaySigusr1RestartPolicy({ allowExternal: true });
    try {
      process.emit("SIGUSR1");
      await run;

      expect(close).toHaveBeenCalledTimes(1);
      expect(signalClose).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 499,
          isLoggedOut: false,
          error: "restart",
        }),
      );
      expect(listenerFactory).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      setGatewaySigusr1RestartPolicy({ allowExternal: false });
    }
  });

  it("exits reconnect backoff immediately when SIGUSR1 requests a restart", async () => {
    let resolveClose: (reason?: unknown) => void = () => {};
    const close = vi.fn(async () => undefined);
    const sleep = vi.fn(
      async () =>
        await new Promise<void>(() => {
          // The restart signal should short-circuit this wait.
        }),
    );
    const listenerFactory = vi.fn(async () => {
      const onClose = new Promise<unknown>((res) => {
        resolveClose = res;
      });
      return { close, onClose, signalClose: vi.fn() };
    });
    const { run, runtime } = startMonitorWebChannel({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory,
      sleep,
      reconnect: { initialMs: 10_000, maxMs: 10_000, maxAttempts: 3, factor: 1.1 },
    });

    await Promise.resolve();
    expect(listenerFactory).toHaveBeenCalledTimes(1);

    resolveClose({ status: 500, isLoggedOut: false, error: "socket closed" });
    await vi.waitFor(
      () => {
        expect(sleep).toHaveBeenCalledTimes(1);
      },
      { timeout: 250, interval: 2 },
    );

    setGatewaySigusr1RestartPolicy({ allowExternal: true });
    try {
      process.emit("SIGUSR1");
      await run;

      expect(listenerFactory).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("status 500"));
    } finally {
      setGatewaySigusr1RestartPolicy({ allowExternal: false });
    }
  });

  it("exits listener startup immediately when SIGUSR1 requests a restart", async () => {
    const sleep = vi.fn(async () => {});
    let resolveListener:
      | ((listener: {
          close: () => Promise<void>;
          signalClose: (reason?: unknown) => void;
        }) => void)
      | null = null;
    const close = vi.fn(async () => undefined);
    const signalClose = vi.fn();
    const listenerFactory = vi.fn(
      async () =>
        await new Promise<{ close: () => Promise<void>; signalClose: (reason?: unknown) => void }>(
          (resolve) => {
            resolveListener = resolve;
          },
        ),
    );
    const { run } = startMonitorWebChannel({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory,
      sleep,
    });

    await Promise.resolve();
    expect(listenerFactory).toHaveBeenCalledTimes(1);

    setGatewaySigusr1RestartPolicy({ allowExternal: true });
    try {
      process.emit("SIGUSR1");
      resolveListener?.({ close, signalClose });
      await run;

      expect(listenerFactory).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      await vi.waitFor(
        () => {
          expect(close).toHaveBeenCalledTimes(1);
          expect(signalClose).toHaveBeenCalledWith(
            expect.objectContaining({
              status: 499,
              isLoggedOut: false,
              error: "restart",
            }),
          );
        },
        { timeout: 250, interval: 2 },
      );
    } finally {
      setGatewaySigusr1RestartPolicy({ allowExternal: false });
    }
  });

  it("removes the SIGUSR1 handler when listener startup throws", async () => {
    const sleep = vi.fn(async () => {});
    const listenerFactory = vi.fn(async () => {
      throw new Error("startup failed");
    });
    const sigusr1Before = process.listenerCount("SIGUSR1");

    await expect(
      startMonitorWebChannel({
        monitorWebChannelFn: monitorWebChannel as never,
        listenerFactory,
        sleep,
      }).run,
    ).rejects.toThrow("startup failed");

    expect(process.listenerCount("SIGUSR1")).toBe(sigusr1Before);
  });

  it("forces reconnect when watchdog closes without onClose", async () => {
    vi.useFakeTimers();
    try {
      const sleep = vi.fn(async () => {});
      const closeResolvers: Array<(reason: unknown) => void> = [];
      let capturedOnMessage:
        | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
        | undefined;
      const listenerFactory = vi.fn(
        async (opts: {
          onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
        }) => {
          capturedOnMessage = opts.onMessage;
          let resolveClose: (reason: unknown) => void = () => {};
          const onClose = new Promise<unknown>((res) => {
            resolveClose = res;
            closeResolvers.push(res);
          });
          return {
            close: vi.fn(),
            onClose,
            signalClose: (reason?: unknown) => resolveClose(reason),
          };
        },
      );
      const { controller, run } = startMonitorWebChannel({
        monitorWebChannelFn: monitorWebChannel as never,
        listenerFactory,
        sleep,
        heartbeatSeconds: 60,
        messageTimeoutMs: 30,
        watchdogCheckMs: 5,
      });

      await Promise.resolve();
      expect(listenerFactory).toHaveBeenCalledTimes(1);
      await vi.waitFor(
        () => {
          expect(capturedOnMessage).toBeTypeOf("function");
        },
        { timeout: 250, interval: 2 },
      );

      const reply = vi.fn().mockResolvedValue(undefined);
      const sendComposing = vi.fn();
      const sendMedia = vi.fn();

      void capturedOnMessage?.(
        makeInboundMessage({
          body: "hi",
          from: "+1",
          to: "+2",
          id: "m1",
          sendComposing,
          reply,
          sendMedia,
        }),
      );

      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
      await vi.waitFor(
        () => {
          expect(listenerFactory).toHaveBeenCalledTimes(2);
        },
        { timeout: 250, interval: 2 },
      );

      controller.abort();
      closeResolvers[1]?.({ status: 499, isLoggedOut: false });
      await Promise.resolve();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("processes inbound messages without batching and preserves timestamps", async () => {
    await withEnvAsync({ TZ: "Europe/Vienna" }, async () => {
      const originalMax = process.getMaxListeners();
      process.setMaxListeners?.(1);

      const store = await makeSessionStore({
        main: { sessionId: "sid", updatedAt: Date.now() },
      });

      try {
        const sendMedia = vi.fn();
        const reply = vi.fn().mockResolvedValue(undefined);
        const sendComposing = vi.fn();
        const resolver = vi.fn().mockResolvedValue({ text: "ok" });

        const capture = createWebListenerFactoryCapture();

        setLoadConfigMock(() => ({
          agents: {
            defaults: {
              envelopeTimezone: "utc",
            },
          },
          session: { store: store.storePath },
        }));

        await monitorWebChannel(false, capture.listenerFactory as never, false, resolver);
        const capturedOnMessage = capture.getOnMessage();
        expect(capturedOnMessage).toBeDefined();

        await capturedOnMessage?.(
          makeInboundMessage({
            body: "first",
            from: "+1",
            to: "+2",
            id: "m1",
            timestamp: 1735689600000,
            sendComposing,
            reply,
            sendMedia,
          }),
        );
        await capturedOnMessage?.(
          makeInboundMessage({
            body: "second",
            from: "+1",
            to: "+2",
            id: "m2",
            timestamp: 1735693200000,
            sendComposing,
            reply,
            sendMedia,
          }),
        );

        expect(resolver).toHaveBeenCalledTimes(2);
        const firstArgs = resolver.mock.calls[0][0];
        const secondArgs = resolver.mock.calls[1][0];
        const firstTimestamp = formatEnvelopeTimestamp(new Date("2025-01-01T00:00:00Z"));
        const secondTimestamp = formatEnvelopeTimestamp(new Date("2025-01-01T01:00:00Z"));
        const firstPattern = escapeRegExp(firstTimestamp);
        const secondPattern = escapeRegExp(secondTimestamp);
        expect(firstArgs.Body).toMatch(
          new RegExp(`\\[WhatsApp \\+1 (\\+\\d+[smhd] )?${firstPattern}\\] \\[openclaw\\] first`),
        );
        expect(firstArgs.Body).not.toContain("second");
        expect(secondArgs.Body).toMatch(
          new RegExp(`\\[WhatsApp \\+1 (\\+\\d+[smhd] )?${secondPattern}\\] \\[openclaw\\] second`),
        );
        expect(secondArgs.Body).not.toContain("first");
        expect(process.getMaxListeners?.()).toBeGreaterThanOrEqual(50);
      } finally {
        process.setMaxListeners?.(originalMax);
        await store.cleanup();
        resetLoadConfigMock();
      }
    });
  });

  it("emits heartbeat logs with connection metadata", async () => {
    vi.useFakeTimers();
    const logPath = `/tmp/openclaw-heartbeat-${crypto.randomUUID()}.log`;
    setLoggerOverride({ level: "trace", file: logPath });

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const controller = new AbortController();
    const listenerFactory = vi.fn(async () => {
      const onClose = new Promise<void>(() => {
        // never resolves; abort will short-circuit
      });
      return { close: vi.fn(), onClose };
    });

    const run = monitorWebChannel(
      false,
      listenerFactory as never,
      true,
      async () => ({ text: "ok" }),
      runtime as never,
      controller.signal,
      {
        heartbeatSeconds: 1,
        reconnect: { initialMs: 5, maxMs: 5, maxAttempts: 1, factor: 1.1 },
      },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await vi.runAllTimersAsync();
    await run.catch(() => {});

    const content = await fs.readFile(logPath, "utf-8");
    expect(content).toMatch(/web-heartbeat/);
    expect(content).toMatch(/connectionId/);
    expect(content).toMatch(/messagesHandled/);
  });

  it("logs outbound replies to file", async () => {
    const logPath = `/tmp/openclaw-log-test-${crypto.randomUUID()}.log`;
    setLoggerOverride({ level: "trace", file: logPath });

    const capture = createWebListenerFactoryCapture();

    const resolver = vi.fn().mockResolvedValue({ text: "auto" });
    await monitorWebChannel(false, capture.listenerFactory as never, false, resolver as never);
    const capturedOnMessage = capture.getOnMessage();
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1",
      conversationId: "+1",
      to: "+2",
      accountId: "default",
      chatType: "direct",
      chatId: "+1",
      id: "msg1",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    });

    const content = await fs.readFile(logPath, "utf-8");
    expect(content).toMatch(/web-auto-reply/);
    expect(content).toMatch(/auto/);
  });

  it("marks dispatch idle after replies flush", async () => {
    const markDispatchIdle = vi.fn();
    const typingMock = {
      onReplyStart: vi.fn(async () => {}),
      startTypingLoop: vi.fn(async () => {}),
      startTypingOnText: vi.fn(async () => {}),
      refreshTypingTtl: vi.fn(),
      isActive: vi.fn(() => false),
      markRunComplete: vi.fn(),
      markDispatchIdle,
      cleanup: vi.fn(),
    };
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn().mockResolvedValue(undefined);
    const sendMedia = vi.fn().mockResolvedValue(undefined);

    const replyResolver = vi.fn().mockImplementation(async (_ctx, opts) => {
      opts?.onTypingController?.(typingMock);
      return { text: "final reply" };
    });

    const mockConfig: OpenClawConfig = {
      channels: { whatsapp: { allowFrom: ["*"] } },
    };

    setLoadConfigMock(mockConfig);

    await monitorWebChannel(
      false,
      async ({ onMessage }) => {
        await onMessage({
          id: "m1",
          from: "+1000",
          conversationId: "+1000",
          to: "+2000",
          body: "hello",
          timestamp: Date.now(),
          chatType: "direct",
          chatId: "direct:+1000",
          accountId: "default",
          sendComposing,
          reply,
          sendMedia,
        });
        return createMockWebListener();
      },
      false,
      replyResolver,
    );

    resetLoadConfigMock();

    expect(markDispatchIdle).toHaveBeenCalled();
  });
});
