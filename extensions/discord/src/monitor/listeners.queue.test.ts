import { afterEach, describe, expect, it, vi } from "vitest";
import { discordEventQueueLog, runDiscordListenerWithSlowLog } from "./listeners.queue.js";

afterEach(() => vi.restoreAllMocks());

describe("Discord listener completion", () => {
  it.each([29_999, 30_000])(
    "preserves rejection and warns at the threshold (%i ms)",
    async (elapsed) => {
      let now = 1_000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
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

  it("does not fabricate a slow-listener warning when the wall clock steps forward", async () => {
    let monotonic = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_700_000_000_000)
      .mockReturnValue(1_700_000_000_000 + 3_600_000);
    const warning = vi.spyOn(discordEventQueueLog, "warn").mockImplementation(() => {});

    await runDiscordListenerWithSlowLog({
      logger: undefined,
      listener: "ThreadUpdateListener",
      event: "THREAD_UPDATE",
      run: async () => {
        monotonic += 1_000;
      },
    });

    expect(warning).not.toHaveBeenCalled();
  });

  it("still flags a genuinely slow listener when the wall clock steps backward", async () => {
    let monotonic = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_700_000_000_000)
      .mockReturnValue(1_700_000_000_000 - 3_600_000);
    const warning = vi.spyOn(discordEventQueueLog, "warn").mockImplementation(() => {});

    await runDiscordListenerWithSlowLog({
      logger: undefined,
      listener: "ThreadUpdateListener",
      event: "THREAD_UPDATE",
      run: async () => {
        monotonic += 31_000;
      },
    });

    expect(warning).toHaveBeenCalledExactlyOnceWith(
      "Slow listener detected",
      expect.objectContaining({ durationMs: 31_000 }),
    );
  });
});
