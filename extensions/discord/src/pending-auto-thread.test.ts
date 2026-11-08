import { describe, expect, it, vi } from "vitest";
import {
  registerPendingDiscordAutoThread,
  resolveDiscordTypingChannelId,
  resolvePendingDiscordAutoThreadChannel,
} from "./pending-auto-thread.js";

describe("pending discord autoThread registry", () => {
  it("passes unknown channels through untouched", async () => {
    expect(await resolvePendingDiscordAutoThreadChannel("plain-channel")).toBe("plain-channel");
    expect(resolveDiscordTypingChannelId("plain-channel")).toBe("plain-channel");
  });

  it("creates the thread once for concurrent senders and reuses the result", async () => {
    const create = vi.fn(async () => "thread-1");
    const dispose = registerPendingDiscordAutoThread({
      threadId: "thread-1",
      parentChannelId: "parent",
      create,
    });

    const results = await Promise.all([
      resolvePendingDiscordAutoThreadChannel("thread-1"),
      resolvePendingDiscordAutoThreadChannel("thread-1"),
    ]);
    expect(results).toEqual(["thread-1", "thread-1"]);
    expect(await resolvePendingDiscordAutoThreadChannel("thread-1")).toBe("thread-1");
    expect(create).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("types in the parent until the thread exists, then in the thread", async () => {
    const dispose = registerPendingDiscordAutoThread({
      threadId: "thread-2",
      parentChannelId: "parent",
      create: async () => "thread-2",
    });

    expect(resolveDiscordTypingChannelId("thread-2")).toBe("parent");
    await resolvePendingDiscordAutoThreadChannel("thread-2");
    expect(resolveDiscordTypingChannelId("thread-2")).toBe("thread-2");
    dispose();
  });

  it("falls back to the parent channel when creation fails or throws", async () => {
    const disposeEmpty = registerPendingDiscordAutoThread({
      threadId: "thread-3",
      parentChannelId: "parent",
      create: async () => undefined,
    });
    const disposeThrowing = registerPendingDiscordAutoThread({
      threadId: "thread-4",
      parentChannelId: "parent",
      create: async () => {
        throw new Error("Missing Permissions");
      },
    });

    expect(await resolvePendingDiscordAutoThreadChannel("thread-3")).toBe("parent");
    expect(await resolvePendingDiscordAutoThreadChannel("thread-4")).toBe("parent");
    expect(resolveDiscordTypingChannelId("thread-4")).toBe("parent");
    disposeEmpty();
    disposeThrowing();
  });

  it("stops intercepting a channel once disposed", async () => {
    const create = vi.fn(async () => "thread-5");
    const dispose = registerPendingDiscordAutoThread({
      threadId: "thread-5",
      parentChannelId: "parent",
      create,
    });
    dispose();

    expect(await resolvePendingDiscordAutoThreadChannel("thread-5")).toBe("thread-5");
    expect(create).not.toHaveBeenCalled();
  });

  it("expires entries that never send anything", async () => {
    vi.useFakeTimers();
    try {
      const create = vi.fn(async () => "thread-6");
      registerPendingDiscordAutoThread({
        threadId: "thread-6",
        parentChannelId: "parent",
        create,
      });
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);

      expect(await resolvePendingDiscordAutoThreadChannel("thread-6")).toBe("thread-6");
      expect(create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the entry once the thread exists so later sends go straight to it", async () => {
    const create = vi.fn(async () => "thread-7");
    registerPendingDiscordAutoThread({
      threadId: "thread-7",
      parentChannelId: "parent",
      create,
    });

    await resolvePendingDiscordAutoThreadChannel("thread-7");
    await resolvePendingDiscordAutoThreadChannel("thread-7");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
