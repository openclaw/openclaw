import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSlackThreadMute,
  clearSlackThreadMuteCache,
  isSlackThreadMutedWithPersistence,
  recordSlackThreadMute,
} from "./muted-thread-cache.js";
import { clearSlackRuntime, setSlackRuntime } from "./runtime.js";

describe("slack muted-thread-cache", () => {
  afterEach(() => {
    clearSlackThreadMuteCache();
    clearSlackRuntime();
    vi.restoreAllMocks();
  });

  it("records and detects a muted thread", async () => {
    recordSlackThreadMute({ accountId: "A1", channelId: "C123", threadTs: "t1" });
    await expect(
      isSlackThreadMutedWithPersistence({ accountId: "A1", channelId: "C123", threadTs: "t1" }),
    ).resolves.toBe(true);
  });

  it("returns false for unrecorded threads", async () => {
    await expect(
      isSlackThreadMutedWithPersistence({ accountId: "A1", channelId: "C123", threadTs: "t1" }),
    ).resolves.toBe(false);
  });

  it("scopes mute state by accountId, channel, and thread", async () => {
    recordSlackThreadMute({ accountId: "A1", channelId: "C123", threadTs: "t1" });
    await expect(
      isSlackThreadMutedWithPersistence({ accountId: "A2", channelId: "C123", threadTs: "t1" }),
    ).resolves.toBe(false);
    await expect(
      isSlackThreadMutedWithPersistence({ accountId: "A1", channelId: "C456", threadTs: "t1" }),
    ).resolves.toBe(false);
    await expect(
      isSlackThreadMutedWithPersistence({ accountId: "A1", channelId: "C123", threadTs: "t2" }),
    ).resolves.toBe(false);
  });

  it("ignores empty accountId, channelId, or threadTs", async () => {
    recordSlackThreadMute({ accountId: "", channelId: "C123", threadTs: "t1" });
    recordSlackThreadMute({ accountId: "A1", channelId: "", threadTs: "t1" });
    recordSlackThreadMute({ accountId: "A1", channelId: "C123", threadTs: "" });
    await expect(
      isSlackThreadMutedWithPersistence({ accountId: "", channelId: "C123", threadTs: "t1" }),
    ).resolves.toBe(false);
    await expect(
      isSlackThreadMutedWithPersistence({ accountId: "A1", channelId: "", threadTs: "t1" }),
    ).resolves.toBe(false);
    await expect(
      isSlackThreadMutedWithPersistence({ accountId: "A1", channelId: "C123", threadTs: "" }),
    ).resolves.toBe(false);
  });

  it("clearSlackThreadMute removes the entry from both hot cache and persistent store", async () => {
    const deletePersistent = vi.fn().mockResolvedValue(true);
    setSlackRuntime({
      state: {
        openKeyedStore: vi.fn(() => ({
          register: vi.fn().mockResolvedValue(undefined),
          lookup: vi.fn().mockResolvedValue(undefined),
          consume: vi.fn(),
          delete: deletePersistent,
          entries: vi.fn(),
          clear: vi.fn(),
        })),
      },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    recordSlackThreadMute({ accountId: "A1", channelId: "C123", threadTs: "t1" });
    await clearSlackThreadMute({ accountId: "A1", channelId: "C123", threadTs: "t1" });

    expect(deletePersistent).toHaveBeenCalledWith("A1:C123:t1");
    await expect(
      isSlackThreadMutedWithPersistence({ accountId: "A1", channelId: "C123", threadTs: "t1" }),
    ).resolves.toBe(false);
  });

  it("writes persistent mute without a TTL so the mute does not expire", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const openKeyedStore = vi.fn(() => ({
      register,
      lookup: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn(),
      delete: vi.fn().mockResolvedValue(true),
      entries: vi.fn(),
      clear: vi.fn(),
    }));
    setSlackRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    vi.spyOn(Date, "now").mockReturnValue(1_777_000_000_000);
    recordSlackThreadMute({ accountId: "A1", channelId: "C123", threadTs: "t1" });

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register).toHaveBeenCalledWith("A1:C123:t1", { mutedAt: 1_777_000_000_000 });
    const firstCall = openKeyedStore.mock.calls[0] as unknown as
      | [{ defaultTtlMs?: number }]
      | undefined;
    expect(firstCall?.[0]?.defaultTtlMs).toBeUndefined();
  });

  it("falls back to in-memory state when persistent store cannot open", async () => {
    const warn = vi.fn();
    setSlackRuntime({
      state: {
        openKeyedStore: vi.fn(() => {
          throw new Error("sqlite unavailable");
        }),
      },
      logging: { getChildLogger: () => ({ warn }) },
    } as never);

    recordSlackThreadMute({ accountId: "A1", channelId: "C123", threadTs: "t1" });
    await expect(
      isSlackThreadMutedWithPersistence({ accountId: "A1", channelId: "C123", threadTs: "t1" }),
    ).resolves.toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
