import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { __gatewayPluginTesting } from "./gateway-plugin.js";

const { wrapWebSocketWithErrorGuard } = __gatewayPluginTesting;

describe("wrapWebSocketWithErrorGuard", () => {
  function createMockWebSocket() {
    const emitter = new EventEmitter();
    return emitter as unknown as import("ws").WebSocket;
  }

  it("passes through non-close events unchanged", () => {
    const ws = createMockWebSocket();
    const wrapped = wrapWebSocketWithErrorGuard(ws);
    const messageHandler = vi.fn();

    wrapped.on("message", messageHandler);
    wrapped.emit("message", "hello");

    expect(messageHandler).toHaveBeenCalledWith("hello");
  });

  it("passes through close events when no error is thrown", () => {
    const ws = createMockWebSocket();
    const wrapped = wrapWebSocketWithErrorGuard(ws);
    const closeHandler = vi.fn();

    wrapped.on("close", closeHandler);
    wrapped.emit("close", 1000, "normal");

    expect(closeHandler).toHaveBeenCalledWith(1000, "normal");
  });

  it("converts thrown errors during close to error events (#53644)", async () => {
    const ws = createMockWebSocket();
    const wrapped = wrapWebSocketWithErrorGuard(ws);
    const errorHandler = vi.fn();

    const thrownError = new Error("Max reconnect attempts (0) reached after code 1006");

    wrapped.on("close", () => {
      throw thrownError;
    });
    wrapped.on("error", errorHandler);

    // The emit should not throw
    expect(() => wrapped.emit("close", 1006, "abnormal")).not.toThrow();

    // Wait for setImmediate to fire
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorHandler).toHaveBeenCalledWith(thrownError);
  });

  it("does not convert thrown errors from non-close events", () => {
    const ws = createMockWebSocket();
    const wrapped = wrapWebSocketWithErrorGuard(ws);
    const thrownError = new Error("some other error");

    wrapped.on("message", () => {
      throw thrownError;
    });

    // Non-close events should still throw (Node.js default EventEmitter behavior)
    expect(() => wrapped.emit("message", "test")).toThrow(thrownError);
  });

  it("returns true from emit when close handler throws", async () => {
    const ws = createMockWebSocket();
    const wrapped = wrapWebSocketWithErrorGuard(ws);
    const errorHandler = vi.fn();

    wrapped.on("close", () => {
      throw new Error("close error");
    });
    // Add error handler to prevent unhandled error in test
    wrapped.on("error", errorHandler);

    const result = wrapped.emit("close", 1006);
    expect(result).toBe(true);

    // Wait for setImmediate to fire
    await new Promise((resolve) => setImmediate(resolve));
    expect(errorHandler).toHaveBeenCalled();
  });

  it("swallows error when no error listeners are registered during setImmediate", async () => {
    const ws = createMockWebSocket();
    const wrapped = wrapWebSocketWithErrorGuard(ws);

    wrapped.on("close", () => {
      throw new Error("close error with no listeners");
    });

    // No error handler registered - should not throw
    expect(() => wrapped.emit("close", 1006)).not.toThrow();

    // Wait for setImmediate to fire - should swallow the error (log it)
    // and not throw an uncaught exception
    await new Promise((resolve) => setImmediate(resolve));

    // If we get here without an uncaught exception, the test passes
  });
});
