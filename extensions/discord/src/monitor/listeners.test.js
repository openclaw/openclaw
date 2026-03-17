import { describe, expect, it, vi } from "vitest";
import { DiscordMessageListener } from "./listeners.js";
function createLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn()
  };
}
function fakeEvent(channelId) {
  return { channel_id: channelId };
}
function createDeferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("DiscordMessageListener", () => {
  it("returns immediately without awaiting handler completion", async () => {
    let resolveHandler;
    const handlerDone = new Promise((resolve) => {
      resolveHandler = resolve;
    });
    const handler = vi.fn(async () => {
      await handlerDone;
    });
    const logger = createLogger();
    const listener = new DiscordMessageListener(handler, logger);
    await expect(listener.handle(fakeEvent("ch-1"), {})).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });
    expect(logger.error).not.toHaveBeenCalled();
    resolveHandler?.();
    await handlerDone;
  });
  it("runs handlers for the same channel concurrently (no per-channel serialization)", async () => {
    const order = [];
    const deferredA = createDeferred();
    const deferredB = createDeferred();
    let callCount = 0;
    const handler = vi.fn(async () => {
      callCount += 1;
      const id = callCount;
      order.push(`start:${id}`);
      if (id === 1) {
        await deferredA.promise;
      } else {
        await deferredB.promise;
      }
      order.push(`end:${id}`);
    });
    const listener = new DiscordMessageListener(handler, createLogger());
    await listener.handle(fakeEvent("ch-1"), {});
    await listener.handle(fakeEvent("ch-1"), {});
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(2);
    });
    expect(order).toContain("start:1");
    expect(order).toContain("start:2");
    deferredB.resolve?.();
    await vi.waitFor(() => {
      expect(order).toContain("end:2");
    });
    expect(order).not.toContain("end:1");
    deferredA.resolve?.();
    await vi.waitFor(() => {
      expect(order).toContain("end:1");
    });
  });
  it("runs handlers for different channels in parallel", async () => {
    const deferredA = createDeferred();
    const deferredB = createDeferred();
    const order = [];
    const handler = vi.fn(async (data) => {
      order.push(`start:${data.channel_id}`);
      if (data.channel_id === "ch-a") {
        await deferredA.promise;
      } else {
        await deferredB.promise;
      }
      order.push(`end:${data.channel_id}`);
    });
    const listener = new DiscordMessageListener(handler, createLogger());
    await listener.handle(fakeEvent("ch-a"), {});
    await listener.handle(fakeEvent("ch-b"), {});
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(2);
    });
    expect(order).toContain("start:ch-a");
    expect(order).toContain("start:ch-b");
    deferredB.resolve?.();
    await vi.waitFor(() => {
      expect(order).toContain("end:ch-b");
    });
    expect(order).not.toContain("end:ch-a");
    deferredA.resolve?.();
    await vi.waitFor(() => {
      expect(order).toContain("end:ch-a");
    });
  });
  it("logs async handler failures", async () => {
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const logger = createLogger();
    const listener = new DiscordMessageListener(handler, logger);
    await expect(listener.handle(fakeEvent("ch-1"), {})).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("discord handler failed: Error: boom")
      );
    });
  });
  it("calls onEvent callback for each message", async () => {
    const handler = vi.fn(async () => {
    });
    const onEvent = vi.fn();
    const listener = new DiscordMessageListener(handler, void 0, onEvent);
    await listener.handle(fakeEvent("ch-1"), {});
    await listener.handle(fakeEvent("ch-2"), {});
    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});
