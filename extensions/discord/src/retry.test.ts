// Discord tests cover retry plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createDiscordRetryRunner } from "./retry.js";

const ZERO_DELAY_RETRY = { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 };

describe("createDiscordRetryRunner error classification", () => {
  it.each([["ETIMEDOUT cause", new Error("request failed", { cause: { code: "ETIMEDOUT" } })]])(
    "retries %s",
    async (_name, err) => {
      const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");
      const runner = createDiscordRetryRunner({ retry: ZERO_DELAY_RETRY });
      await expect(runner(fn, "request")).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["403 status", Object.assign(new Error("missing permissions"), { statusCode: 403 })],
    ["plain string", "fetch failed"],
  ])("does not retry %s", async (_name, err) => {
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");
    const runner = createDiscordRetryRunner({ retry: ZERO_DELAY_RETRY });
    await expect(runner(fn, "request")).rejects.toThrow(err instanceof Error ? err.message : err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("createDiscordRetryRunner", () => {
  it("remembers a disconnect when the gateway recovers before the baseline attempts end", async () => {
    const isGatewayDisconnected = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue("ok");
    const runner = createDiscordRetryRunner({
      retry: ZERO_DELAY_RETRY,
      isGatewayDisconnected,
    });

    await expect(runner(fn, "send")).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
