import { describe, expect, it, vi } from "vitest";
import {
  registerPendingDiscordAutoThread,
  resolveDiscordTypingChannelId,
  resolvePendingDiscordAutoThreadChannel,
} from "./pending-auto-thread.js";

describe("pending discord autoThread registry", () => {
  it("passes unknown channels through untouched", async () => {
    expect(await resolvePendingDiscordAutoThreadChannel("account-1", "plain-channel")).toBe(
      "plain-channel",
    );
    expect(resolveDiscordTypingChannelId("account-1", "plain-channel")).toBe("plain-channel");
  });

  it("creates the thread once for concurrent senders and reuses the result", async () => {
    const create = vi.fn(async () => "thread-1");
    const dispose = registerPendingDiscordAutoThread({
      accountId: "account-1",
      threadId: "thread-1",
      parentChannelId: "parent",
      create,
    });

    const results = await Promise.all([
      resolvePendingDiscordAutoThreadChannel("account-1", "thread-1"),
      resolvePendingDiscordAutoThreadChannel("account-1", "thread-1"),
    ]);

    expect(results).toEqual(["thread-1", "thread-1"]);
    expect(await resolvePendingDiscordAutoThreadChannel("account-1", "thread-1")).toBe("thread-1");
    expect(create).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("isolates pending entries between Discord accounts with the same thread ID", async () => {
    const createAccount1 = vi.fn(async () => "thread-account-1");
    const createAccount2 = vi.fn(async () => "thread-account-2");

    const disposeAccount1 = registerPendingDiscordAutoThread({
      accountId: "account-1",
      threadId: "shared-thread-id",
      parentChannelId: "parent-account-1",
      create: createAccount1,
    });

    const disposeAccount2 = registerPendingDiscordAutoThread({
      accountId: "account-2",
      threadId: "shared-thread-id",
      parentChannelId: "parent-account-2",
      create: createAccount2,
    });

    expect(resolveDiscordTypingChannelId("account-1", "shared-thread-id")).toBe("parent-account-1");
    expect(resolveDiscordTypingChannelId("account-2", "shared-thread-id")).toBe("parent-account-2");

    const resultAccount1 = await resolvePendingDiscordAutoThreadChannel(
      "account-1",
      "shared-thread-id",
    );
    const resultAccount2 = await resolvePendingDiscordAutoThreadChannel(
      "account-2",
      "shared-thread-id",
    );

    expect(resultAccount1).toBe("thread-account-1");
    expect(resultAccount2).toBe("thread-account-2");
    expect(createAccount1).toHaveBeenCalledTimes(1);
    expect(createAccount2).toHaveBeenCalledTimes(1);

    disposeAccount1();
    disposeAccount2();
  });

  it("types in the parent until the thread exists, then in the thread", async () => {
    const dispose = registerPendingDiscordAutoThread({
      accountId: "account-1",
      threadId: "thread-2",
      parentChannelId: "parent",
      create: async () => "thread-2",
    });

    expect(resolveDiscordTypingChannelId("account-1", "thread-2")).toBe("parent");
    await resolvePendingDiscordAutoThreadChannel("account-1", "thread-2");
    expect(resolveDiscordTypingChannelId("account-1", "thread-2")).toBe("thread-2");
    dispose();
  });

  it("falls back to the parent channel when creation fails or throws", async () => {
    const disposeEmpty = registerPendingDiscordAutoThread({
      accountId: "account-1",
      threadId: "thread-3",
      parentChannelId: "parent",
      create: async () => undefined,
    });

    const disposeThrowing = registerPendingDiscordAutoThread({
      accountId: "account-1",
      threadId: "thread-4",
      parentChannelId: "parent",
      create: async () => {
        throw new Error("Missing Permissions");
      },
    });

    expect(await resolvePendingDiscordAutoThreadChannel("account-1", "thread-3")).toBe("parent");
    expect(await resolvePendingDiscordAutoThreadChannel("account-1", "thread-4")).toBe("parent");
    expect(resolveDiscordTypingChannelId("account-1", "thread-4")).toBe("parent");

    disposeEmpty();
    disposeThrowing();
  });

  it("stops intercepting a channel once disposed", async () => {
    const create = vi.fn(async () => "thread-5");
    const dispose = registerPendingDiscordAutoThread({
      accountId: "account-1",
      threadId: "thread-5",
      parentChannelId: "parent",
      create,
    });

    dispose();

    expect(await resolvePendingDiscordAutoThreadChannel("account-1", "thread-5")).toBe("thread-5");
    expect(create).not.toHaveBeenCalled();
  });

  it("expires entries that never send anything", async () => {
    vi.useFakeTimers();
    try {
      const create = vi.fn(async () => "thread-6");
      registerPendingDiscordAutoThread({
        accountId: "account-1",
        threadId: "thread-6",
        parentChannelId: "parent",
        create,
      });

      vi.advanceTimersByTime(25 * 60 * 60 * 1000);

      expect(await resolvePendingDiscordAutoThreadChannel("account-1", "thread-6")).toBe(
        "thread-6",
      );
      expect(create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the entry once the thread exists so later sends go straight to it", async () => {
    const create = vi.fn(async () => "thread-7");
    registerPendingDiscordAutoThread({
      accountId: "account-1",
      threadId: "thread-7",
      parentChannelId: "parent",
      create,
    });

    await resolvePendingDiscordAutoThreadChannel("account-1", "thread-7");
    await resolvePendingDiscordAutoThreadChannel("account-1", "thread-7");

    expect(create).toHaveBeenCalledTimes(1);
  });
});
