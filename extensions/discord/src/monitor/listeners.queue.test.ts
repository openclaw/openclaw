import { afterEach, describe, expect, it, vi } from "vitest";
import { discordEventQueueLog, runDiscordListenerWithSlowLog } from "./listeners.queue.js";

afterEach(() => vi.restoreAllMocks());

describe.each([0, -3_600_000, 3_600_000])("Discord listener clock step %dms", (step) => {
  it.each([29_999, 30_000])(
    "preserves rejection and warns at the threshold (%i ms)",
    async (elapsed) => {
      let now = 1_000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const date = vi.spyOn(Date, "now").mockReturnValue(now);
      const warning = vi.spyOn(discordEventQueueLog, "warn").mockImplementation(() => {});
      const failure = new Error("listener failed");

      await expect(
        runDiscordListenerWithSlowLog({
          logger: undefined,
          listener: "ThreadUpdateListener",
          event: "THREAD_UPDATE",
          run: async () => {
            now += elapsed;
            date.mockReturnValue(now + step);
            throw failure;
          },
        }),
      ).rejects.toBe(failure);

      if (elapsed < 30_000) {
        expect(warning).not.toHaveBeenCalled();
      } else {
        expect(warning).toHaveBeenCalledExactlyOnceWith(
          "Slow listener detected",
          expect.objectContaining({ durationMs: elapsed }),
        );
      }
    },
  );
});
