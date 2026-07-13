import { afterEach, describe, expect, it, vi } from "vitest";
import { raceWithTimeout } from "./race-with-timeout.js";

interface VoiceSendResult {
  channel: string;
  error?: string;
  messageId?: string;
}

describe("raceWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears the voice-send timeout after delivery resolves", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await expect(
      raceWithTimeout<VoiceSendResult>(
        async () => ({ channel: "qqbot", messageId: "voice-1" }),
        45_000,
        () => ({ channel: "qqbot", error: "Voice send timed out and was skipped" }),
      ),
    ).resolves.toEqual({ channel: "qqbot", messageId: "voice-1" });

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
