import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const { vision } = vi.hoisted(() => ({ vision: vi.fn(async () => false) }));

vi.mock("./sticker-vision.runtime.js", () => ({
  resolveStickerVisionSupportRuntime: vision,
}));

describe("buildTelegramMessageContext media carriers", () => {
  it("carries direct tool policy into a topic-bound admitted turn", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "private", first_name: "Ada" },
        from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
        message_thread_id: 7,
        is_topic_message: true,
        text: "hello",
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: {
          tools: { deny: ["write"] },
          toolsBySender: {
            "channel:telegram:42": { deny: ["exec"] },
          },
        },
        topicConfig: { agentId: "support" },
      }),
    });

    expect(context?.ctxPayload).toMatchObject({
      ConversationToolPolicy: { deny: ["exec"] },
    });
  });

  it("does not attach direct policy to group turns", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: -42, type: "supergroup", title: "Ops" },
        from: { id: 42, is_bot: false, first_name: "Ada" },
        text: "hello",
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { tools: { deny: ["exec"] }, requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(context?.ctxPayload.ConversationToolPolicy).toBeUndefined();
  });

  it("keeps immediate native sticker kind ahead of MIME and deeper reply media", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "private", first_name: "Ada" },
        text: "What was that?",
      },
      replyChain: [
        {
          messageId: "10",
          sender: "Pat",
          mediaKind: "sticker",
          mediaType: "image/webp",
          replyToId: "9",
        },
        { messageId: "9", sender: "Sam", mediaType: "document" },
      ],
    });

    expect(context?.ctxPayload.ReplyToBody).toBe("<media:sticker>");
    expect(context?.ctxPayload.Body).toContain("[Reply chain - nearest first]");
    expect(context?.ctxPayload.Body).toContain("<media:sticker>");
    expect(context?.ctxPayload.Body).toContain("<media:document>");
  });

  it("keeps the native reply kind when a cached chain is filtered out", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: -1001, type: "supergroup", title: "Ops" },
        from: { id: 1, is_bot: false, first_name: "Ada" },
        text: "What was that?",
        reply_to_message: {
          message_id: 10,
          date: 1_699_999_999,
          chat: { id: -1001, type: "supergroup", title: "Ops" },
          from: { id: 1, is_bot: false, first_name: "Ada" },
          photo: [{ file_id: "photo-1", file_unique_id: "photo-u1", width: 1, height: 1 }],
        },
      },
      cfg: {
        channels: { telegram: { groupPolicy: "allowlist", contextVisibility: "allowlist" } },
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false, allowFrom: ["1"] },
        topicConfig: undefined,
      }),
      replyChain: [{ messageId: "10", sender: "Hidden", senderId: "999", mediaType: "image" }],
    });

    expect(context?.ctxPayload.ReplyToBody).toBe("<media:image>");
    expect(context?.ctxPayload.media?.map((fact) => fact.kind)).toEqual(["image"]);
  });

  it.each(["voice", "audio"] as const)(
    "keeps mixed aggregate media out of command text and distinguishes %s modality",
    async (kind) => {
      const context = await buildTelegramMessageContextForTest({
        message: {
          chat: { id: -1001, type: "supergroup", title: "Ops" },
          text: undefined,
          [kind]: { file_id: "audio-1", file_unique_id: "audio-u1", duration: 1 },
        },
        allMedia: [{ kind: "audio" }, { kind: "image" }, { kind: "document" }],
        historyLimit: 5,
      });

      expect(context?.ctxPayload.RawBody).toBe("");
      expect(context?.ctxPayload.BodyForAgent).toBe("");
      expect(context?.ctxPayload.CommandBody).toBe("");
      expect(context?.ctxPayload.CommandSource).toBeUndefined();
      expect(context?.ctxPayload.media?.map((fact) => fact.kind)).toEqual([
        "audio",
        "image",
        "document",
      ]);
      expect(context?.ctxPayload.SourceModality).toBe(kind === "voice" ? "voice" : undefined);
    },
  );

  it.each([
    { is_animated: true, is_video: false, emoji: "😭", expected: "😭" },
    { is_animated: false, is_video: true, emoji: "😭", expected: "😭" },
    { is_animated: true, is_video: false, emoji: undefined, expected: "<media:sticker>" },
  ])(
    "keeps an unavailable sticker meaningful to the agent: $expected ($is_video)",
    async ({ is_animated, is_video, emoji, expected }) => {
      const context = await buildTelegramMessageContextForTest({
        message: {
          chat: { id: -1001, type: "supergroup", title: "Stickers" },
          text: undefined,
          reply_to_message: {
            message_id: 10,
            date: 1_700_000_000,
            chat: { id: -1001, type: "supergroup", title: "Stickers" },
            from: { id: 7, is_bot: true, first_name: "Bot" },
            text: "No Sunday-only tickets yet.",
          },
          sticker: {
            file_id: "sticker-1",
            file_unique_id: "sticker-u1",
            type: "regular",
            width: 1,
            height: 1,
            is_animated,
            is_video,
            emoji,
          },
        },
        allMedia: [{ kind: "sticker" }],
        resolveTelegramGroupConfig: () => ({
          groupConfig: { requireMention: true },
          topicConfig: undefined,
        }),
      });

      expect(context?.ctxPayload.BodyForAgent).toBe(expected);
      expect(context?.ctxPayload.ReplyToBody).toBe("No Sunday-only tickets yet.");
      expect(context?.ctxPayload.WasMentioned).toBe(true);
    },
  );

  it.each([false, true])(
    "selects cached sticker descriptions versus visual understanding (%s)",
    async (supportsVision) => {
      vision.mockResolvedValueOnce(supportsVision);
      const context = await buildTelegramMessageContextForTest({
        message: {
          chat: { id: -1002, type: "supergroup", title: "Stickers" },
          text: undefined,
          sticker: {
            file_id: "sticker-2",
            file_unique_id: "sticker-u2",
            type: "regular",
            width: 1,
            height: 1,
            is_animated: false,
            is_video: false,
          },
        },
        allMedia: [
          {
            kind: "sticker",
            path: "/tmp/sticker.webp",
            contentType: "image/webp",
            stickerMetadata: {
              fileId: "sticker-2",
              fileUniqueId: "sticker-u2",
              cachedDescription: "A waving sticker",
            },
          },
        ],
        historyLimit: 5,
      });

      expect(context?.ctxPayload.BodyForAgent).toBe(
        supportsVision ? "" : "[Sticker] A waving sticker",
      );
      expect(context?.ctxPayload.media).toEqual([
        expect.objectContaining({ path: "/tmp/sticker.webp", contentType: "image/webp" }),
      ]);
      expect(context?.ctxPayload.StickerMediaIncluded).toBe(true);
      expect(context?.ctxPayload.SkipStickerMediaUnderstanding).toBe(
        supportsVision ? undefined : true,
      );
    },
  );
});
