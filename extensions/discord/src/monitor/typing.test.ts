// Discord tests cover typing plugin behavior.
import { Routes } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { RequestClient } from "../internal/discord.js";
import { createDiscordReplyTypingFeedback } from "./reply-typing-feedback.js";
import { sendTyping } from "./typing.js";

describe("sendTyping", () => {
  it("uses the direct Discord typing REST endpoint", async () => {
    const rest = new RequestClient("test-token");
    const post = vi.spyOn(rest, "post").mockResolvedValue(undefined);

    await sendTyping({
      rest,
      channelId: "12345",
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(Routes.channelTyping("12345"));
  });

  it("times out when the typing endpoint hangs", async () => {
    vi.useFakeTimers();
    try {
      const rest = new RequestClient("test-token");
      vi.spyOn(rest, "post").mockReturnValue(new Promise(() => {}));

      const promise = sendTyping({
        rest,
        channelId: "12345",
      });
      const rejection = expect(promise).rejects.toThrow("discord typing start timed out");

      await vi.advanceTimersByTimeAsync(5_000);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires retained typing when Discord access policy is revoked", async () => {
    vi.useFakeTimers();
    try {
      const rest = new RequestClient("synthetic-token");
      const post = vi.spyOn(rest, "post").mockResolvedValue(undefined);
      let policyCurrent = true;
      const callbacks = createDiscordReplyTypingFeedback({
        cfg: {} as never,
        token: "synthetic-token",
        accountId: "synthetic-account",
        channelId: "12345",
        rest,
        log: vi.fn(),
        isCurrent: () => policyCurrent,
        keepaliveIntervalMs: 1_000,
        maxDurationMs: 0,
      });
      const retireOwner = vi.fn(() => callbacks.onCleanup?.());
      callbacks.setBackgroundWorkFailureHandler?.(retireOwner);

      expect(callbacks.backgroundWorkAudienceKey).toBe(
        JSON.stringify(["discord", "synthetic-account", "12345"]),
      );
      await callbacks.onReplyStart();
      expect(post).toHaveBeenCalledTimes(1);

      policyCurrent = false;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(post).toHaveBeenCalledTimes(1);
      expect(retireOwner).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not rearm a pending producer start after a background pause", async () => {
    vi.useFakeTimers();
    try {
      const rest = new RequestClient("synthetic-token");
      let settleInitialStart: (() => void) | undefined;
      const initialStart = new Promise<void>((resolve) => {
        settleInitialStart = resolve;
      });
      const post = vi
        .spyOn(rest, "post")
        .mockReturnValueOnce(initialStart)
        .mockResolvedValue(undefined);
      const callbacks = createDiscordReplyTypingFeedback({
        cfg: {} as never,
        token: "synthetic-token",
        accountId: "synthetic-account",
        channelId: "12345",
        rest,
        log: vi.fn(),
        keepaliveIntervalMs: 1_000,
        maxDurationMs: 0,
      });

      await callbacks.onReplyStart();
      expect(post).toHaveBeenCalledTimes(1);
      callbacks.onBackgroundWorkPause?.();
      settleInitialStart?.();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(post).toHaveBeenCalledTimes(1);

      // Core ownership regain uses the same production callback to resume.
      await callbacks.onReplyStart();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(post).toHaveBeenCalledTimes(3);
      callbacks.onCleanup?.();
    } finally {
      vi.useRealTimers();
    }
  });
});
