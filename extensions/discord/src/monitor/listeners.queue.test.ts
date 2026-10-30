import { afterEach, describe, expect, it, vi } from "vitest";
import { discordEventQueueLog, runDiscordListenerWithSlowLog } from "./listeners.queue.js";

afterEach(() => vi.restoreAllMocks());

describe("Discord listener completion", () => {
  it.each([29_999, 30_000])(
    "preserves rejection and warns at the threshold (%i ms)",
    async (elapsed) => {
      let now = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const warning = vi.spyOn(discordEventQueueLog, "warn").mockImplementation(() => {});
      const failure = new Error("listener failed");

      await expect(
        runDiscordListenerWithSlowLog({
          logger: undefined,
          listener: "ThreadUpdateListener",
          event: "THREAD_UPDATE",
          run: async () => {
            now += elapsed;
            throw failure;
          },
        }),
      ).rejects.toBe(failure);

      if (elapsed < 30_000) {
        expect(warning).not.toHaveBeenCalled();
      } else {
        expect(warning).toHaveBeenCalledExactlyOnceWith("Slow listener detected", {
          listener: "ThreadUpdateListener",
          event: "THREAD_UPDATE",
          durationMs: 30_000,
          duration: "30 seconds",
          consoleMessage:
            "Slow listener detected: ThreadUpdateListener took 30 seconds for event THREAD_UPDATE",
        });
      }
    },
  );
});
