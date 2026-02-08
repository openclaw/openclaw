import { describe, expect, it, vi } from "vitest";
import { enqueueAnnounce } from "./subagent-announce-queue.js";

describe("subagent announce queue stale policy", () => {
  it("drops stale non-priority announce items", async () => {
    const send = vi.fn(async () => {});
    const key = `stale-${Date.now()}`;

    enqueueAnnounce({
      key,
      send,
      settings: { mode: "followup", debounceMs: 0, maxAgeMs: 10 },
      item: {
        prompt: "stale",
        sessionKey: "agent:main:main",
        enqueuedAt: Date.now() - 60_000,
      },
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(0);
    });
  });

  it("allows stale high-priority announce items to bypass stale gate", async () => {
    const send = vi.fn(async () => {});
    const key = `high-priority-${Date.now()}`;

    enqueueAnnounce({
      key,
      send,
      settings: { mode: "followup", debounceMs: 0, maxAgeMs: 10 },
      item: {
        prompt: "important",
        sessionKey: "agent:main:main",
        enqueuedAt: Date.now() - 60_000,
        highPriority: true,
      },
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});
