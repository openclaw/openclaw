import { MessageFlags, Routes } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { RateLimitError } from "./internal/discord.js";
import { makeDiscordRest, requestBody, requestPath, timerDelayAt } from "./send.test-harness.js";

type SendAssetsAndRetriesDeps = Pick<
  typeof import("./send.js"),
  "listGuildEmojisDiscord" | "sendMessageDiscord" | "sendPollDiscord" | "sendStickerDiscord"
>;

export function registerSendAssetsAndRetriesTests(load: () => SendAssetsAndRetriesDeps): void {
  const cfg = { channels: { discord: { accounts: { default: {} } } } };
  const retry = { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 };
  const clientOpts = (rest: ReturnType<typeof makeDiscordRest>["rest"]) => ({
    cfg,
    rest,
    token: "t",
  });
  const rateLimitError = (retryAfter = 0) =>
    new RateLimitError(
      new Response(null, {
        status: 429,
        headers: { "X-RateLimit-Scope": "user", "X-RateLimit-Bucket": "test-bucket" },
      }),
      { message: "You are being rate limited.", retry_after: retryAfter, global: false },
    );

  describe("structured sends and retries", () => {
    it("lists emojis for a guild", async () => {
      const { rest, getMock } = makeDiscordRest();
      getMock.mockResolvedValue([{ id: "e1", name: "party" }]);
      await load().listGuildEmojisDiscord("g1", clientOpts(rest));
      expect(getMock).toHaveBeenCalledWith(Routes.guildEmojis("g1"));
    });

    it("allows sticker link embeds when suppression is disabled", async () => {
      const { rest, postMock } = makeDiscordRest();
      postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });
      await load().sendStickerDiscord("channel:789", ["123"], {
        ...clientOpts(rest),
        content: "https://example.com",
        suppressEmbeds: false,
      });
      expect(requestBody(postMock)).toMatchObject({
        content: "https://example.com",
        sticker_ids: ["123"],
        enforce_nonce: true,
      });
      expect(requestBody(postMock).flags).toBeUndefined();
    });

    it("preserves poll answers, receipt, and silent flags across a retried 502", async () => {
      const { rest, postMock } = makeDiscordRest();
      postMock
        .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
        .mockResolvedValueOnce({ id: "msg1", channel_id: "789" });
      const result = await load().sendPollDiscord(
        "channel:789",
        { question: "Lunch?", options: ["Pizza", "Sushi"] },
        {
          ...clientOpts(rest),
          threadId: "789",
          silent: true,
          retry,
        },
      );
      expect(result).toMatchObject({
        messageId: "msg1",
        channelId: "789",
        receipt: {
          threadId: "789",
          parts: [{ platformMessageId: "msg1", kind: "poll" }],
        },
      });
      expect(requestPath(postMock)).toBe(Routes.channelMessages("789"));
      expect(requestBody(postMock)).toMatchObject({
        flags: MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications,
        enforce_nonce: true,
        poll: {
          question: { text: "Lunch?" },
          answers: [{ poll_media: { text: "Pizza" } }, { poll_media: { text: "Sushi" } }],
          duration: 24,
          allow_multiselect: false,
          layout_type: 1,
        },
      });
      expect(postMock).toHaveBeenCalledTimes(2);
      expect(requestBody(postMock).nonce).toMatch(/^[0-9a-f]{24}$/);
      expect(requestBody(postMock, 1).nonce).toBe(requestBody(postMock).nonce);
    });

    it("honors retry_after and retries media without duplicating its overflow text", async () => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      const { rest, postMock } = makeDiscordRest();
      postMock
        .mockRejectedValueOnce(rateLimitError(0.001))
        .mockResolvedValueOnce({ id: "msg1", channel_id: "789" })
        .mockResolvedValueOnce({ id: "msg2", channel_id: "789" });
      const sending = load().sendMessageDiscord("channel:789", "a".repeat(2005), {
        ...clientOpts(rest),
        mediaUrl: "https://example.com/photo.jpg",
        retry: { ...retry, maxDelayMs: 1000 },
      });
      await vi.runAllTimersAsync();
      const result = await sending;
      expect(result.messageId).toBe("msg1");
      expect(result.receipt.platformMessageIds).toEqual(["msg1", "msg2"]);
      expect(postMock).toHaveBeenCalledTimes(3);
      expect(timerDelayAt(setTimeoutSpy)).toBe(1);
    });
  });
}
