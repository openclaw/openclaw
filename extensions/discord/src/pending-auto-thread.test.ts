import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerPendingDiscordAutoThread,
  resolveDiscordTypingChannelId,
  resolvePendingDiscordAutoThreadChannel as resolve,
} from "./pending-auto-thread.js";

function register(accountId: string, threadId: string, create: () => Promise<string | undefined>) {
  return registerPendingDiscordAutoThread({
    accountId,
    threadId,
    parentChannelId: "parent",
    create,
  });
}

describe("pending discord autoThread registry", () => {
  afterEach(() => vi.useRealTimers());

  it("creates once for concurrent senders, then targets the thread directly", async () => {
    const create = vi.fn(async () => "t1");
    register("a1", "t1", create);
    expect(resolveDiscordTypingChannelId("a1", "t1")).toBe("parent");
    expect(await Promise.all([resolve("a1", "t1"), resolve("a1", "t1")])).toEqual(["t1", "t1"]);
    expect(await resolve("a1", "t1")).toBe("t1");
    expect(resolveDiscordTypingChannelId("a1", "t1")).toBe("t1");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps accounts that share a thread id apart", async () => {
    register("a1", "shared", async () => "t-a1");
    register("a2", "shared", async () => "t-a2");
    expect(await resolve("a2", "shared")).toBe("t-a2");
    expect(await resolve("a1", "shared")).toBe("t-a1");
  });

  it("falls back to the parent when creation fails or throws", async () => {
    register("a1", "t3", async () => undefined);
    register("a1", "t4", async () => {
      throw new Error("Missing Permissions");
    });
    expect(await resolve("a1", "t3")).toBe("parent");
    expect(await resolve("a1", "t4")).toBe("parent");
  });

  it("stops intercepting once disposed or expired", async () => {
    vi.useFakeTimers();
    const create = vi.fn(async () => "t5");
    register("a1", "t5", create)();
    register("a1", "t6", create);
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    expect(await resolve("a1", "t5")).toBe("t5");
    expect(await resolve("a1", "t6")).toBe("t6");
    expect(create).not.toHaveBeenCalled();
  });
});
