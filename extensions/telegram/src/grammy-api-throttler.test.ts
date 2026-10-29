import { describe, expect, it, vi } from "vitest";
import { createOwnedGrammyApiThrottler } from "./grammy-api-throttler.js";

describe("owned grammY limiter", () => {
  it("clears global, group, DM and cleanup timers and forbids new keys", async () => {
    vi.useFakeTimers();
    const owned = createOwnedGrammyApiThrottler();
    const prev = vi.fn(async () => ({
      ok: false as const,
      error_code: 400,
      description: "fixture response",
    }));
    try {
      const group = owned.transformer(
        prev,
        "sendChatAction",
        { chat_id: -42, action: "typing" },
        undefined,
      );
      const dm = owned.transformer(
        prev,
        "sendChatAction",
        { chat_id: 42, action: "typing" },
        undefined,
      );
      await vi.advanceTimersByTimeAsync(100);
      await Promise.all([group, dm]);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      const disposing = owned.dispose();
      expect(owned.dispose()).toBe(disposing);
      await vi.advanceTimersByTimeAsync(100);
      await disposing;
      expect(vi.getTimerCount()).toBe(0);
      for (const chat_id of [-999, 999]) {
        await expect(
          owned.transformer(prev, "sendChatAction", { chat_id, action: "typing" }, undefined),
        ).rejects.toThrow(/released/i);
      }
      expect(prev).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await owned.dispose();
      vi.useRealTimers();
    }
  });
});

describe("global queue retirement", () => {
  it("rejects a globally reservoir-blocked request before disconnecting", async () => {
    vi.useFakeTimers();
    const owned = createOwnedGrammyApiThrottler();
    const prev = vi.fn(async () => ({
      ok: false as const,
      error_code: 400,
      description: "fixture response",
    }));
    try {
      const calls = Array.from({ length: 31 }, (_, index) =>
        owned.transformer(
          prev,
          "sendChatAction",
          { chat_id: index + 1, action: "typing" },
          undefined,
        ),
      );
      const results = Promise.allSettled(calls);
      await vi.advanceTimersByTimeAsync(100);
      expect(prev).toHaveBeenCalledTimes(30);
      const disposing = owned.dispose();
      await vi.advanceTimersByTimeAsync(100);
      await disposing;
      const settled = await results;
      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(30);
      expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(prev).toHaveBeenCalledTimes(30);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await owned.dispose();
      vi.useRealTimers();
    }
  });
});
