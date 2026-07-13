import { describe, expect, it, vi } from "vitest";
import { createRetryRunner, retryAsync } from "./index.js";

describe("retryAsync", () => {
  it.each([0, 0.5])(
    "never rounds an honorable Retry-After below its floor with jitter=%s",
    async (jitter) => {
      const sleeps: number[] = [];
      const run = createRetryRunner({ sleep: async (ms) => void sleeps.push(ms) });
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error("rate limited"))
        .mockResolvedValueOnce("ok");

      await expect(
        run(operation, {
          attempts: 2,
          minDelayMs: 0,
          maxDelayMs: 10,
          jitter,
          random: () => 0,
          retryAfterMs: () => 1.4,
        }),
      ).resolves.toBe("ok");
      expect(sleeps).toEqual([2]);
    },
  );

  it("supports custom schedules, abortable sleeps, and async retry hooks", async () => {
    const events: string[] = [];
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValueOnce("ok");

    await expect(
      retryAsync(operation, {
        attempts: 3,
        minDelayMs: 0,
        maxDelayMs: 100,
        delayMs: ({ attempt }) => [10, 30][attempt - 1] ?? 0,
        onRetry: async ({ attempt }) => void events.push(`retry:${attempt}`),
        sleep: async (ms) => void events.push(`sleep:${ms}`),
      }),
    ).resolves.toBe("ok");
    expect(events).toEqual(["retry:1", "sleep:10", "retry:2", "sleep:30"]);
  });

  it("preserves terminal Error identity", async () => {
    const terminal = new Error("terminal");
    await expect(
      retryAsync(
        async () => {
          throw terminal;
        },
        {
          attempts: 1,
        },
      ),
    ).rejects.toBe(terminal);
  });

  it("clamps numeric overload delays to the Node timer ceiling", async () => {
    const sleeps: number[] = [];
    const run = createRetryRunner({ sleep: async (ms) => void sleeps.push(ms) });
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockResolvedValueOnce("ok");

    await run(operation, 2, Number.POSITIVE_INFINITY);
    expect(sleeps).toEqual([2_147_000_000]);
  });
});
