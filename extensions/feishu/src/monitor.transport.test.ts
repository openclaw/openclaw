import { describe, expect, it, vi } from "vitest";
import { createFeishuWsLifecycleLogger } from "./monitor.transport.js";

describe("createFeishuWsLifecycleLogger", () => {
  it("tracks reconnect and ready lifecycle into channel status", () => {
    const statusSink = vi.fn();
    const logger = createFeishuWsLifecycleLogger({
      accountId: "default",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
      statusSink,
    });

    logger.info("[ws]", "reconnect");
    logger.info("[ws]", "ws client ready");

    expect(statusSink).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        connected: false,
        reconnectAttempts: 1,
        lastDisconnect: expect.objectContaining({
          at: expect.any(Number),
        }),
      }),
    );
    expect(statusSink).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        connected: true,
        reconnectAttempts: 0,
        lastConnectedAt: expect.any(Number),
        lastDisconnect: null,
        lastError: null,
      }),
    );
  });

  it("records websocket errors as disconnect state", () => {
    const statusSink = vi.fn();
    const runtimeError = vi.fn();
    const logger = createFeishuWsLifecycleLogger({
      accountId: "default",
      runtime: {
        log: vi.fn(),
        error: runtimeError,
        exit: vi.fn(),
      },
      statusSink,
    });

    logger.error("[ws]", "ws connect failed");

    expect(runtimeError).toHaveBeenCalled();
    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({
        connected: false,
        reconnectAttempts: 1,
        lastDisconnect: expect.objectContaining({
          at: expect.any(Number),
          error: expect.stringContaining("ws connect failed"),
        }),
        lastError: expect.stringContaining("ws connect failed"),
      }),
    );
  });

  it("translates Feishu connection-limit errors into an actionable message", () => {
    const statusSink = vi.fn();
    const runtimeError = vi.fn();
    const logger = createFeishuWsLifecycleLogger({
      accountId: "default",
      runtime: {
        log: vi.fn(),
        error: runtimeError,
        exit: vi.fn(),
      },
      statusSink,
    });

    logger.error("[ws]", "code: 1000040350, system busy");

    expect(runtimeError).toHaveBeenCalled();
    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({
        connected: false,
        reconnectAttempts: 1,
        lastError: expect.stringContaining("connection limit reached"),
      }),
    );
  });

  it("marks repeated reconnect-failed info logs as disconnected", () => {
    const statusSink = vi.fn();
    const logger = createFeishuWsLifecycleLogger({
      accountId: "default",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
      statusSink,
    });

    logger.info("ws", 'unable to connect to the server after trying 1 times")');

    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({
        connected: false,
        reconnectAttempts: 1,
      }),
    );
  });

  it("treats reconnect success info logs as connected", () => {
    const statusSink = vi.fn();
    const logger = createFeishuWsLifecycleLogger({
      accountId: "default",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
      statusSink,
    });

    logger.info("[ws]", "reconnect");
    logger.info("[ws]", "reconnect success");

    expect(statusSink).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        connected: false,
        reconnectAttempts: 1,
      }),
    );
    expect(statusSink).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        connected: true,
        reconnectAttempts: 0,
        lastConnectedAt: expect.any(Number),
        lastDisconnect: null,
        lastError: null,
      }),
    );
  });
});
