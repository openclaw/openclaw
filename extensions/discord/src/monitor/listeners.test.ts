// Discord tests cover listeners plugin behavior.
import { beforeAll, describe, expect, it, vi } from "vitest";

let DiscordMessageListener: typeof import("./listeners.js").DiscordMessageListener;
let DiscordMessageUpdateListener: typeof import("./listeners.js").DiscordMessageUpdateListener;
let DiscordMessageDeleteListener: typeof import("./listeners.js").DiscordMessageDeleteListener;
let DiscordInteractionListener: typeof import("./listeners.js").DiscordInteractionListener;

beforeAll(async () => {
  ({
    DiscordMessageListener,
    DiscordMessageUpdateListener,
    DiscordMessageDeleteListener,
    DiscordInteractionListener,
  } = await import("./listeners.js"));
});

function createLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
}

function firstErrorMessage(logger: ReturnType<typeof createLogger>): string {
  const firstCall = logger.error.mock.calls[0];
  if (!firstCall) {
    throw new Error("expected logger.error call");
  }
  expect(firstCall).toHaveLength(1);
  return String(firstCall[0]);
}

function fakeEvent(channelId: string) {
  return { channel_id: channelId } as never;
}

function createDeferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("DiscordMessageListener", () => {
  it("returns immediately without awaiting handler completion", async () => {
    let resolveHandler: (() => void) | undefined;
    const handlerDone = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });
    const handler = vi.fn(async () => {
      await handlerDone;
    });
    const logger = createLogger();
    const listener = new DiscordMessageListener(handler as never, logger as never);

    await expect(listener.handle(fakeEvent("ch-1"), {} as never)).resolves.toBeUndefined();
    // Handler was dispatched but may not have been called yet (fire-and-forget).
    // Wait for the microtask to flush so the handler starts.
    await flushAsyncWork();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();

    resolveHandler?.();
    await handlerDone;
  });

  it("runs handlers for the same channel concurrently (no per-channel serialization)", async () => {
    const order: string[] = [];
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
    const listener = new DiscordMessageListener(handler as never, createLogger() as never);

    // Both messages target the same channel — previously serialized, now concurrent.
    await listener.handle(fakeEvent("ch-1"), {} as never);
    await listener.handle(fakeEvent("ch-1"), {} as never);

    await flushAsyncWork();
    expect(handler).toHaveBeenCalledTimes(2);
    // Both handlers started without waiting for the first to finish.
    expect(order).toContain("start:1");
    expect(order).toContain("start:2");

    deferredB.resolve?.();
    await flushAsyncWork();
    expect(order).toContain("end:2");
    // First handler is still running — no serialization.
    expect(order).not.toContain("end:1");

    deferredA.resolve?.();
    await flushAsyncWork();
    expect(order).toContain("end:1");
  });

  it("runs handlers for different channels in parallel", async () => {
    const deferredA = createDeferred();
    const deferredB = createDeferred();
    const order: string[] = [];
    const handler = vi.fn(async (data: { channel_id: string }) => {
      order.push(`start:${data.channel_id}`);
      if (data.channel_id === "ch-a") {
        await deferredA.promise;
      } else {
        await deferredB.promise;
      }
      order.push(`end:${data.channel_id}`);
    });
    const listener = new DiscordMessageListener(handler as never, createLogger() as never);

    await listener.handle(fakeEvent("ch-a"), {} as never);
    await listener.handle(fakeEvent("ch-b"), {} as never);

    await flushAsyncWork();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(order).toContain("start:ch-a");
    expect(order).toContain("start:ch-b");

    deferredB.resolve?.();
    await flushAsyncWork();
    expect(order).toContain("end:ch-b");
    expect(order).not.toContain("end:ch-a");

    deferredA.resolve?.();
    await flushAsyncWork();
    expect(order).toContain("end:ch-a");
  });

  it("logs async handler failures", async () => {
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const logger = createLogger();
    const listener = new DiscordMessageListener(handler as never, logger as never);

    await expect(listener.handle(fakeEvent("ch-1"), {} as never)).resolves.toBeUndefined();
    await flushAsyncWork();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(firstErrorMessage(logger)).toContain("discord handler failed: Error: boom");
  });

  it("calls onEvent callback for each message", async () => {
    const handler = vi.fn(async () => {});
    const onEvent = vi.fn();
    const listener = new DiscordMessageListener(handler as never, undefined, onEvent);

    await listener.handle(fakeEvent("ch-1"), {} as never);
    await listener.handle(fakeEvent("ch-2"), {} as never);

    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});

describe("DiscordMessageUpdateListener", () => {
  function editEvent(overrides: Record<string, unknown> = {}) {
    return {
      channel_id: "ch-1",
      content: "edited text",
      edited_timestamp: "2026-06-10T01:02:03.000Z",
      message: { id: "m-1", channel_id: "ch-1" },
      ...overrides,
    } as never;
  }

  it("dispatches user edits to the handler with edit metadata", async () => {
    const handler = vi.fn(async () => {});
    const onEvent = vi.fn();
    const listener = new DiscordMessageUpdateListener(handler as never, undefined, onEvent);

    await listener.handle(editEvent(), {} as never);
    await flushAsyncWork();

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    const options = handler.mock.calls[0]?.[2] as { edit?: { editedTimestamp?: string } };
    expect(options?.edit?.editedTimestamp).toBe("2026-06-10T01:02:03.000Z");
  });

  it("ignores updates without edited_timestamp (embed unfurls, pins)", async () => {
    const handler = vi.fn(async () => {});
    const onEvent = vi.fn();
    const listener = new DiscordMessageUpdateListener(handler as never, undefined, onEvent);

    await listener.handle(editEvent({ edited_timestamp: undefined }), {} as never);
    await listener.handle(editEvent({ edited_timestamp: null }), {} as never);
    await flushAsyncWork();

    expect(handler).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("ignores partial updates without hydrated content", async () => {
    const handler = vi.fn(async () => {});
    const listener = new DiscordMessageUpdateListener(handler as never);

    await listener.handle(editEvent({ content: undefined }), {} as never);
    await flushAsyncWork();

    expect(handler).not.toHaveBeenCalled();
  });

  it("logs async handler failures", async () => {
    const handler = vi.fn(async () => {
      throw new Error("edit boom");
    });
    const logger = createLogger();
    const listener = new DiscordMessageUpdateListener(handler as never, logger as never);

    await listener.handle(editEvent(), {} as never);
    await flushAsyncWork();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(firstErrorMessage(logger)).toContain(
      "discord message-update handler failed: Error: edit boom",
    );
  });
});

describe("DiscordMessageDeleteListener", () => {
  it("cancels the run triggered by the deleted message", async () => {
    const cancelRun = vi.fn(() => true);
    const logger = createLogger();
    const onEvent = vi.fn();
    const listener = new DiscordMessageDeleteListener(cancelRun, logger as never, onEvent);

    await listener.handle({ id: "m-1", channel_id: "ch-1" });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(cancelRun).toHaveBeenCalledWith({
      channelId: "ch-1",
      messageId: "m-1",
      reason: "discord source message deleted",
    });
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when no active run matches the deleted message", async () => {
    const cancelRun = vi.fn(() => false);
    const logger = createLogger();
    const listener = new DiscordMessageDeleteListener(cancelRun, logger as never);

    await listener.handle({ id: "m-2", channel_id: "ch-1" });

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs cancel hook failures", async () => {
    const cancelRun = vi.fn(() => {
      throw new Error("cancel boom");
    });
    const logger = createLogger();
    const listener = new DiscordMessageDeleteListener(cancelRun, logger as never);

    await listener.handle({ id: "m-3", channel_id: "ch-1" });

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(firstErrorMessage(logger)).toContain(
      "discord message-delete handler failed: Error: cancel boom",
    );
  });
});

describe("DiscordInteractionListener", () => {
  it("returns immediately without awaiting Discord interaction handling", async () => {
    const handlerDone = createDeferred();
    const handleInteraction = vi.fn(async () => {
      await handlerDone.promise;
    });
    const logger = createLogger();
    const listener = new DiscordInteractionListener(logger as never);

    await expect(
      listener.handle({ id: "interaction-1" } as never, { handleInteraction } as never),
    ).resolves.toBeUndefined();
    await flushAsyncWork();
    expect(handleInteraction).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();

    handlerDone.resolve?.();
    await flushAsyncWork();
  });

  it("logs async interaction failures", async () => {
    const handleInteraction = vi.fn(async () => {
      throw new Error("interaction boom");
    });
    const logger = createLogger();
    const listener = new DiscordInteractionListener(logger as never);

    await listener.handle({ id: "interaction-1" } as never, { handleInteraction } as never);
    await flushAsyncWork();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(firstErrorMessage(logger)).toContain(
      "discord interaction handler failed: Error: interaction boom",
    );
  });

  it("calls onEvent callback for each interaction", async () => {
    const handleInteraction = vi.fn(async () => {});
    const onEvent = vi.fn();
    const listener = new DiscordInteractionListener(undefined, onEvent);

    await listener.handle({ id: "interaction-1" } as never, { handleInteraction } as never);
    await listener.handle({ id: "interaction-2" } as never, { handleInteraction } as never);

    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});
