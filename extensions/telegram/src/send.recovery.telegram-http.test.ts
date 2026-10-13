import fs from "node:fs/promises";
import path from "node:path";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import * as mediaRuntime from "openclaw/plugin-sdk/media-runtime";
import {
  addTestHook,
  createEmptyPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import * as webMedia from "openclaw/plugin-sdk/web-media";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverReplies } from "./bot/delivery.js";
import { createTelegramPromptContextProjectionSequence } from "./prompt-context-projection.js";
import { editMessageTelegram, sendLocationTelegram, sendMessageTelegram } from "./send.js";
import {
  resolveTelegramTestUpload,
  useTelegramHttpFixture,
} from "./send.telegram-http.test-support.js";

describe("Telegram send recovery conformance over HTTP", () => {
  const fixture = useTelegramHttpFixture();
  const { cfg, requests, rejections, runtime, buttons, sendThrough } = fixture;
  let bot: typeof fixture.bot;
  let photoPath: string;
  let photos: string[];
  let voicePath: string;
  beforeAll(async () => {
    voicePath = path.join(fixture.mediaDir, "note.ogg");
    await fs.writeFile(
      voicePath,
      Buffer.concat([
        Buffer.from("OggS"),
        Buffer.alloc(24),
        Buffer.from("OpusHead"),
        Buffer.alloc(32),
      ]),
    );
    photos = await Promise.all(
      Array.from({ length: 11 }, async (_, index) => {
        const file = path.join(fixture.mediaDir, `album-${index}.png`);
        await fs.copyFile(fixture.photoPath, file);
        return file;
      }),
    );
  });
  afterEach(() => {
    resetGlobalHookRunner();
    vi.restoreAllMocks();
  });
  const deliver = (
    replies: Parameters<typeof deliverReplies>[0]["replies"],
    options: Partial<Parameters<typeof deliverReplies>[0]> = {},
  ) =>
    deliverReplies({
      cfg,
      bot,
      runtime,
      chatId: "123",
      token: cfg.channels.telegram.botToken,
      mediaLocalRoots: [fixture.mediaDir],
      replyToMode: "off",
      textLimit: 4000,
      replies,
      ...options,
    });
  beforeEach(() => {
    ({ bot, photoPath } = fixture);
  });

  it.each(["direct", "public"] as const)(
    "keeps %s first-reply ownership and final controls on multipart rich fallback",
    async (entry) => {
      rejections.push("Bad Request: RICH_MESSAGE_CONTENT_REQUIRED");
      const result = await sendThrough(
        entry,
        "A".repeat(4500),
        async () => {},
        undefined,
        true,
        undefined,
        {
          firstReply: true,
          textLimit: 32_768,
          linkPreview: false,
        },
      );
      expect(requests.map(({ method }) => method)).toEqual([
        "sendRichMessage",
        "sendMessage",
        "sendMessage",
      ]);
      expect(requests[0]!.fields.rich_message).toMatchObject({ skip_entity_detection: true });
      expect(requests.slice(1).map(({ fields }) => fields.parse_mode)).toEqual([
        undefined,
        undefined,
      ]);
      expect(requests.slice(1).map(({ fields }) => fields.text)).toEqual([
        "A".repeat(4000),
        "A".repeat(500),
      ]);
      expect(requests.slice(1).map(({ fields }) => fields.reply_parameters)).toEqual(
        entry === "direct"
          ? [{ message_id: 7, quote: "quote", allow_sending_without_reply: true }, undefined]
          : [undefined, undefined],
      );
      expect(requests.slice(1).map(({ fields }) => fields.reply_markup)).toEqual([
        undefined,
        { inline_keyboard: buttons },
      ]);
      expect(requests.slice(1).map(({ fields }) => fields.link_preview_options)).toEqual([
        { is_disabled: true },
        { is_disabled: true },
      ]);
      expect(result.receipt?.platformMessageIds).toEqual(["2", "3"]);
    },
  );

  it.each([
    {
      rejection: "can't parse entities",
      text: `**${"x".repeat(1024)}**`,
      captions: [`<b>${"x".repeat(1024)}</b>`, "x".repeat(1024)],
    },
    { rejection: "text must be non-empty", text: "\u200b", captions: ["\u200b", undefined] },
  ])(
    "recovers a rejected caption ($rejection) without duplicating accepted media",
    async ({ rejection, text, captions }) => {
      rejections.push(`Bad Request: ${rejection}`);
      const result = await sendThrough(
        "direct",
        text,
        async () => {},
        photoPath,
        false,
        undefined,
        { textMode: "markdown" },
      );
      expect(requests.map(({ method }) => method)).toEqual(["sendPhoto", "sendPhoto"]);
      expect(requests.map(({ fields }) => fields.caption)).toEqual(captions);
      expect(requests[1]!.fields.parse_mode).toBeUndefined();
      expect(result).toMatchObject({ receipt: { platformMessageIds: ["2"] } });
    },
  );

  it.each([
    { kind: "rich", rejection: "CHAT_WRITE_FORBIDDEN", method: "sendRichMessage" },
    { kind: "photo", rejection: "message thread not found", method: "sendPhoto" },
  ])(
    "does not retry a $kind send after $rejection",
    async ({ kind, rejection, method: expectedMethod }) => {
      rejections.push(`Bad Request: ${rejection}`);
      await expect(
        sendThrough(
          "direct",
          "answer",
          async () => {},
          kind === "photo" ? photoPath : undefined,
          kind === "rich",
          undefined,
          kind === "rich" ? {} : { threadId: 77 },
        ),
      ).rejects.toThrow(rejection);
      expect(requests.map(({ method }) => method)).toEqual([expectedMethod]);
      if (kind === "photo") {
        expect(requests[0]!.fields.message_thread_id).toBe("77");
      }
    },
  );

  it.each([
    ["image/png", "sendPhoto", "photo", "image.png"],
    ["video/quicktime", "sendVideo", "video", "video.mov"],
    ["audio/mpeg", "sendAudio", "audio", "audio.mp3"],
    ["image/gif", "sendAnimation", "animation", "animation.gif"],
    ["application/x-custom", "sendDocument", "document", "file.bin"],
  ])(
    "serializes anonymous %s media with its MIME-derived filename",
    async (contentType, method, field, filename) => {
      vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
        buffer: Buffer.from("external-loader-bytes"),
        contentType,
        kind: undefined,
      });
      await deliverReplies({
        cfg,
        bot,
        runtime,
        chatId: "123",
        token: cfg.channels.telegram.botToken,
        replies: [{ mediaUrl: "https://example.com/anonymous" }],
        replyToMode: "off",
        textLimit: 4000,
      });
      expect(requests.map((request) => request.method)).toEqual([method]);
      const upload = resolveTelegramTestUpload(requests[0]!.fields, field);
      expect(upload.name).toBe(filename);
      expect(await upload.text()).toBe("external-loader-bytes");
    },
  );

  it.each(["direct", "public"] as const)(
    "batches %s photos with one caption and reply, preserving the trailing singleton",
    async (entry) => {
      const result =
        entry === "direct"
          ? await deliver([{ text: "Album", mediaUrls: photos, replyToId: "7" }], {
              replyToMode: "first",
              thread: { scope: "forum", id: 77 },
              silent: true,
            })
          : await sendMessageTelegram("123", "Album", {
              cfg,
              api: bot.api,
              mediaUrls: photos,
              mediaLocalRoots: [fixture.mediaDir],
              replyToMessageId: 7,
              replyToIdSource: "implicit",
              replyToMode: "first",
              messageThreadId: 77,
              silent: true,
            });
      expect(requests.map(({ method }) => method)).toEqual(["sendMediaGroup", "sendPhoto"]);
      const album = JSON.parse(String(requests[0]!.fields.media));
      expect(album).toHaveLength(10);
      expect(album.map((item: { caption?: string }) => item.caption)).toEqual([
        "Album",
        ...Array(9).fill(undefined),
      ]);
      expect(requests.map(({ fields }) => String(fields.message_thread_id))).toEqual(["77", "77"]);
      expect(requests.map(({ fields }) => String(fields.disable_notification))).toEqual([
        "true",
        "true",
      ]);
      expect(String(requests[0]!.fields.reply_to_message_id)).toBe("7");
      expect(requests[1]!.fields.reply_to_message_id).toBeUndefined();
      expect(requests[1]!.fields.reply_parameters).toBeUndefined();
      expect(result.receipt?.platformMessageIds).toEqual([
        ...Array.from({ length: 10 }, (_, index) => String(1001 + index)),
        "2",
      ]);
    },
  );

  it.each(["observer", "abort", "revoked"] as const)(
    "keeps an accepted album receipt when the next batch is stopped by %s",
    async (failure) => {
      const abort = new AbortController();
      let authorized = true;
      const ids = Array.from({ length: 10 }, (_, index) => String(1001 + index));
      await expect(
        sendMessageTelegram("123", "Album", {
          cfg,
          api: bot.api,
          mediaUrls: photos,
          mediaLocalRoots: [fixture.mediaDir],
          messageThreadId: 77,
          signal: abort.signal,
          assertPlatformSendAuthorized: () => {
            if (!authorized) {
              throw new Error("authority revoked");
            }
          },
          onDeliveryResult: ({ messageId }) => {
            if (failure === "observer") {
              throw new Error("observer failed");
            }
            if (messageId === ids.at(-1)) {
              if (failure === "abort") {
                abort.abort();
              } else if (failure === "revoked") {
                authorized = false;
              }
            }
          },
        }),
      ).rejects.toMatchObject({
        deliveryResult: {
          messageIds: ids,
          receipt: { platformMessageIds: ids, threadId: "77" },
        },
      });
      expect(requests.map(({ method }) => method)).toEqual(["sendMediaGroup"]);
    },
  );

  it("records every accepted album part before a streaming observer can fail", async () => {
    const sequence = createTelegramPromptContextProjectionSequence({
      record: async () => {
        throw new Error("projection unavailable");
      },
    });
    const accepted = vi.fn();
    await expect(
      deliver([{ mediaUrls: photos.slice(0, 2) }], {
        promptContextSequence: sequence,
        onMediaAccepted: accepted,
      }),
    ).rejects.toMatchObject({ deliveryResult: { messageIds: ["1001", "1002"] } });
    expect(accepted).toHaveBeenCalledExactlyOnceWith(photos.slice(0, 2));
    expect(requests.map(({ method }) => method)).toEqual(["sendMediaGroup"]);
  });

  it.each(["photo-rejected", "unrelated-rejection"] as const)(
    "keeps album recovery and caption ordering under %s",
    async (outcome) => {
      rejections.push(
        outcome === "photo-rejected"
          ? "Bad Request: PHOTO_INVALID_DIMENSIONS"
          : "Bad Request: CHAT_WRITE_FORBIDDEN",
      );
      if (outcome === "photo-rejected") {
        rejections.push("Bad Request: PHOTO_INVALID_DIMENSIONS");
      }
      const sending = deliver([{ text: "x".repeat(1100), mediaUrls: photos.slice(0, 2) }]);
      if (outcome === "unrelated-rejection") {
        await expect(sending).rejects.toThrow("CHAT_WRITE_FORBIDDEN");
        expect(requests.map(({ method }) => method)).toEqual(["sendMediaGroup"]);
      } else {
        const result = await sending;
        expect(requests.map(({ method }) => method)).toEqual([
          "sendMediaGroup",
          "sendPhoto",
          "sendDocument",
          "sendPhoto",
          "sendMessage",
        ]);
        expect(requests.at(-1)!.fields.text).toBe("x".repeat(1100));
        expect(result.receipt?.platformMessageIds).toEqual(["3", "4", "5"]);
      }
    },
  );

  it.each(["text", "album"] as const)(
    "stops %s continuation on a wrong-topic acceptance without losing the receipt",
    async (kind) => {
      fixture.responseFor = (method) =>
        method.startsWith("send")
          ? kind === "album"
            ? [
                {
                  message_id: 51,
                  date: 1700000000,
                  chat: { id: 123, type: "supergroup" },
                  message_thread_id: 77,
                },
                {
                  message_id: 52,
                  date: 1700000000,
                  chat: { id: 123, type: "supergroup" },
                  message_thread_id: 88,
                },
              ]
            : {
                message_id: 51,
                date: 1700000000,
                chat: { id: 123, type: "supergroup" },
                message_thread_id: 88,
              }
          : undefined;
      await expect(
        deliver(
          [
            {
              text: "A".repeat(8000),
              ...(kind === "album" ? { mediaUrls: photos.slice(0, 2) } : {}),
            },
          ],
          { thread: { scope: "forum", id: 77 }, richMessages: false, textLimit: 32768 },
        ),
      ).rejects.toMatchObject({
        deliveryResult: {
          messageIds: kind === "album" ? ["51", "52"] : ["51"],
          receipt:
            kind === "album"
              ? { parts: [{ threadId: "77" }, { threadId: "88" }] }
              : { threadId: "88" },
        },
      });
      expect(requests).toHaveLength(1);
    },
  );

  it("classifies migration rejection as not dispatched without rewriting the destination", async () => {
    rejections.push({
      error_code: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      parameters: { migrate_to_chat_id: -100123 },
    });
    const error = await sendThrough("public", "answer", async () => {}).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({
      retryable: false,
      message: expect.stringContaining("-100123"),
    });
    expect(requests.map(({ fields }) => fields.chat_id)).toEqual(["123"]);
  });

  it.each(["accepted", "forbidden", "unrelated", "missing-fallback", "caption-too-long"] as const)(
    "settles a voice reply with %s provider outcome and mirrors only accepted content",
    async (outcome) => {
      const voice = voicePath;
      const registry = createEmptyPluginRegistry();
      addTestHook({
        registry,
        pluginId: "voice-content",
        hookName: "message_sending",
        handler: (event: { content: string }) =>
          event.content === "spoken fallback" ? { content: "Allowed fallback" } : undefined,
      });
      initializeGlobalHookRunner(registry);
      if (outcome === "caption-too-long") {
        rejections.push(
          "Bad Request: caption is too long",
          "",
          "Bad Request: text must be non-empty",
          "Bad Request: text must be non-empty",
        );
      } else if (outcome !== "accepted") {
        rejections.push(
          outcome === "unrelated"
            ? "Bad Request: CHAT_WRITE_FORBIDDEN"
            : "VOICE_MESSAGES_FORBIDDEN",
        );
      }
      const mirror = vi.fn();
      const recordingAt: number[] = [];
      const sending = deliver(
        [
          {
            mediaUrl: voice,
            audioAsVoice: true,
            ...(outcome === "caption-too-long"
              ? { text: "\u200b".repeat(1024) }
              : outcome === "missing-fallback"
                ? {}
                : { spokenText: "spoken fallback" }),
          },
        ],
        {
          transcriptMirror: mirror,
          onVoiceRecording: () => {
            recordingAt.push(requests.length);
          },
        },
      );
      if (outcome === "unrelated" || outcome === "missing-fallback") {
        await expect(sending).rejects.toThrow(
          outcome === "unrelated" ? "CHAT_WRITE_FORBIDDEN" : "VOICE_MESSAGES_FORBIDDEN",
        );
        expect(mirror).not.toHaveBeenCalled();
      } else {
        await expect(sending).resolves.toMatchObject({
          delivered: true,
          ...(outcome === "caption-too-long" ? { receipt: { platformMessageIds: ["2"] } } : {}),
        });
        expect(mirror).toHaveBeenCalledExactlyOnceWith({
          text: outcome === "caption-too-long" ? undefined : "Allowed fallback",
          mediaUrls: outcome === "forbidden" ? undefined : [voice],
        });
      }
      expect(recordingAt).toEqual([0]);
      expect(requests.map(({ method }) => method)).toEqual(
        outcome === "caption-too-long"
          ? ["sendVoice", "sendVoice", "sendMessage", "sendMessage"]
          : outcome === "forbidden"
            ? ["sendVoice", "sendMessage"]
            : ["sendVoice"],
      );
      expect(requests[outcome === "caption-too-long" ? 1 : 0]!.fields.caption).toBeUndefined();
      if (outcome === "forbidden") {
        expect(requests[1]!.fields.text).toBe("Allowed fallback");
      }
    },
  );

  it.each([false, true])(
    "keeps accepted text when a delivery pin fails (required: %s)",
    async (required) => {
      rejections.push("", "Bad Request: not enough rights");
      const sending = deliver([{ text: "answer", delivery: { pin: { enabled: true, required } } }]);
      if (required) {
        await expect(sending).rejects.toMatchObject({
          deliveryResult: { messageIds: ["1"], visibleReplySent: true },
        });
      } else {
        await expect(sending).resolves.toMatchObject({ delivered: true });
      }
      expect(requests.map(({ method }) => method)).toEqual(["sendMessage", "pinChatMessage"]);
      expect(requests[1]!.fields.message_id).toBe(1);
    },
  );

  it.each(["literal", "rewrite", "blank", "rejected"] as const)(
    "reports %s content through real hooks and the prompt projection",
    async (outcome) => {
      const registry = createEmptyPluginRegistry();
      const observed = vi.fn();
      const sent = vi.fn();
      addTestHook({ registry, pluginId: "receipt", hookName: "message_sent", handler: sent });
      if (outcome === "rewrite" || outcome === "blank") {
        addTestHook({
          registry,
          pluginId: "rewrite",
          hookName: "message_sending",
          handler: () => ({ content: outcome === "rewrite" ? "Allowed" : "  " }),
        });
      }
      initializeGlobalHookRunner(registry);
      const sequence = createTelegramPromptContextProjectionSequence({
        source: { transcriptMessageId: "assistant-1" },
        record: async (record) => {
          observed(record);
          return true;
        },
      });
      if (outcome === "rejected") {
        rejections.push("Bad Request: CHAT_WRITE_FORBIDDEN");
      }
      const sending = deliver([{ text: "<code>&lt;b&gt;x&lt;/b&gt;</code>" }], {
        textMode: "html",
        promptContextSequence: sequence,
      });
      if (outcome === "rejected") {
        await expect(sending).rejects.toThrow("CHAT_WRITE_FORBIDDEN");
        await sequence.fail();
      } else {
        await sending;
        await sequence.finish();
      }
      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({ success: outcome === "literal" || outcome === "rewrite" }),
        expect.anything(),
      );
      if (outcome === "blank" || outcome === "rejected") {
        expect(observed).not.toHaveBeenCalled();
      } else {
        expect(observed).toHaveBeenCalledExactlyOnceWith(
          outcome === "rewrite"
            ? { messageId: 1, text: "Allowed" }
            : {
                messageId: 1,
                text: "<b>x</b>",
                projection: { transcriptMessageId: "assistant-1", partIndex: 0, finalPart: true },
              },
        );
      }
      expect(requests.map(({ fields }) => fields.text)).toEqual(
        outcome === "blank"
          ? []
          : [outcome === "rewrite" ? "Allowed" : "<code>&lt;b&gt;x&lt;/b&gt;</code>"],
      );
    },
  );
  it("keeps accepted media and voice fallback text receipts when later media is rejected", async () => {
    rejections.push("", "VOICE_MESSAGES_FORBIDDEN", "", "Bad Request: CHAT_WRITE_FORBIDDEN");
    const mirror = vi.fn();
    const sending = deliver(
      [
        {
          mediaUrls: [photos[0]!, voicePath, photos[1]!],
          audioAsVoice: true,
          spokenText: "Voice fallback",
        },
      ],
      { transcriptMirror: mirror },
    );
    await expect(sending).rejects.toMatchObject({
      deliveryResult: { messageIds: ["1", "3"] },
    });
    expect(mirror).not.toHaveBeenCalled();
    expect(requests[1]!.method).toBe("sendVoice");
    expect(requests[2]!.method).toBe("sendMessage");
  });

  it.each([false, true])(
    "retains accepted media when its empty follow-up needs a keyboard retrofit (rejected: %s)",
    async (rejected) => {
      const empty = "Bad Request: text must be non-empty";
      rejections.push(
        "",
        empty,
        empty,
        ...(rejected ? ["Bad Request: keyboard retrofit failed"] : []),
      );
      const sending = sendMessageTelegram("123", "\u200b".repeat(1025), {
        cfg,
        api: bot.api,
        textMode: "html",
        mediaUrl: photoPath,
        mediaLocalRoots: [fixture.mediaDir],
        buttons,
      });
      if (rejected) {
        await expect(sending).rejects.toMatchObject({ deliveryResult: { messageIds: ["1"] } });
      } else {
        await expect(sending).resolves.toMatchObject({
          messageId: "1",
          meta: { telegramHasInlineKeyboard: true },
        });
      }
      expect(requests.map(({ method }) => method)).toEqual([
        "sendPhoto",
        "sendMessage",
        "sendMessage",
        "editMessageReplyMarkup",
      ]);
      expect(requests.at(-1)!.fields).toMatchObject({
        message_id: 1,
        reply_markup: { inline_keyboard: buttons },
      });
    },
  );

  it.each([false, true])(
    "preserves mixed upload order with forced documents=%s",
    async (forceDocument) => {
      const document = path.join(fixture.mediaDir, "report.pdf");
      await fs.writeFile(document, "%PDF-1.4\nreport");
      await sendMessageTelegram("123", "Attachments", {
        cfg,
        api: bot.api,
        mediaUrls: [photos[0]!, photos[1]!, document, photos[2]!, photos[3]!],
        mediaLocalRoots: [fixture.mediaDir],
        forceDocument,
      });
      expect(requests.map(({ method }) => method)).toEqual(
        forceDocument
          ? Array(5).fill("sendDocument")
          : ["sendMediaGroup", "sendDocument", "sendMediaGroup"],
      );
      const names = requests.flatMap(({ fields }) =>
        typeof fields.media === "string"
          ? (JSON.parse(fields.media) as Array<{ media: string }>).map(
              (item) => resolveTelegramTestUpload({ ...fields, photo: item.media }, "photo").name,
            )
          : [resolveTelegramTestUpload(fields, "document").name],
      );
      expect(names).toEqual([
        "album-0.png",
        "album-1.png",
        "report.pdf",
        "album-2.png",
        "album-3.png",
      ]);
    },
  );

  it.each(["unknown", "too-wide"] as const)(
    "uses a document when photo dimensions are %s",
    async (shape) => {
      vi.spyOn(mediaRuntime, "getImageMetadata").mockResolvedValue(
        shape === "unknown" ? null : { width: 4000, height: 100 },
      );
      await sendMessageTelegram("123", "Caption", {
        cfg,
        api: bot.api,
        mediaUrl: photoPath,
        mediaLocalRoots: [fixture.mediaDir],
      });
      expect(requests.map(({ method }) => method)).toEqual(["sendDocument"]);
      expect(
        Buffer.from(await resolveTelegramTestUpload(requests[0]!.fields, "document").arrayBuffer()),
      ).toEqual(await fs.readFile(photoPath));
    },
  );

  it("consumes an implicit first reply on media before its oversized caption follow-up", async () => {
    await sendMessageTelegram("123", "A".repeat(1100), {
      cfg,
      api: bot.api,
      mediaUrl: photoPath,
      mediaLocalRoots: [fixture.mediaDir],
      replyToMessageId: 7,
      replyToIdSource: "implicit",
      replyToMode: "first",
    });
    expect(requests.map(({ fields }) => fields.reply_to_message_id)).toEqual(["7", undefined]);
  });

  it("preserves a mismatched native venue receipt", async () => {
    fixture.responseFor = () => ({
      message_id: 303,
      message_thread_id: 100,
      chat: { id: -100123, type: "supergroup" },
    });
    await expect(
      sendLocationTelegram(
        "-100123:topic:99",
        {
          latitude: 48.858844,
          longitude: 2.294351,
          name: "Eiffel Tower",
          address: "Champ de Mars",
        },
        { cfg, api: bot.api },
      ),
    ).rejects.toMatchObject({
      deliveryResult: { messageIds: ["303"], receipt: { threadId: "100" } },
    });
    expect(requests.map(({ method }) => method)).toEqual(["sendVenue"]);
  });

  it("keeps durable voice privacy fallback context on a rich account", async () => {
    rejections.push("Bad Request: VOICE_MESSAGES_FORBIDDEN");
    await sendMessageTelegram("123:topic:77", "Hello **there**", {
      cfg: { channels: { telegram: { ...cfg.channels.telegram, richMessages: true } } },
      api: bot.api,
      mediaUrl: voicePath,
      mediaLocalRoots: [fixture.mediaDir],
      asVoice: true,
      replyToMessageId: 7,
      silent: true,
      buttons,
    });
    expect(requests.map(({ method }) => method)).toEqual(["sendVoice", "sendRichMessage"]);
    expect(requests[1]!.fields).toMatchObject({
      message_thread_id: 77,
      disable_notification: true,
      reply_markup: { inline_keyboard: buttons },
      reply_parameters: { message_id: 7 },
    });
  });

  it("enforces the configured upload limit before reaching Telegram", async () => {
    await expect(
      sendMessageTelegram("123", "", {
        cfg: {
          channels: { telegram: { ...cfg.channels.telegram, mediaMaxMb: 1 / (1024 * 1024) } },
        },
        api: bot.api,
        mediaUrl: photoPath,
        mediaLocalRoots: [fixture.mediaDir],
      }),
    ).rejects.toMatchObject({ name: "ImageOptimizationLimitError", maxBytes: 1 });
    expect(requests).toEqual([]);
  });

  it("sends WAV media requested as voice using sendAudio", async () => {
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      buffer: Buffer.from("audio-bytes"),
      kind: "audio",
      contentType: "audio/wav",
      fileName: "note.wav",
    });
    await sendMessageTelegram("123", "Caption", {
      cfg,
      api: bot.api,
      mediaUrl: "https://example.com/audio",
      asVoice: true,
    });
    expect(requests.map((request) => request.method)).toEqual(["sendAudio"]);
    expect(await resolveTelegramTestUpload(requests[0]!.fields, "audio").text()).toBe(
      "audio-bytes",
    );
  });

  it("does not claim delivery when all text is rejected as empty", async () => {
    const description = "text must be non-empty";
    rejections.push(`Bad Request: ${description}`, `Bad Request: ${description}`);
    await expect(sendMessageTelegram("123", "\u200b", { cfg, api: bot.api })).rejects.toThrow(
      description,
    );
    expect(requests.map(({ method }) => method)).toEqual(["sendMessage", "sendMessage"]);
  });

  it("keeps authored link destinations through an HTML rejection", async () => {
    rejections.push("Bad Request: can't parse entities");
    await sendMessageTelegram("123", "Read [docs](https://example.com/guide)", {
      cfg,
      api: bot.api,
    });
    expect(requests.map(({ fields }) => fields.text)).toEqual([
      'Read <a href="https://example.com/guide">docs</a>',
      "Read docs (https://example.com/guide)",
    ]);
    const text = "[reference]: https://example.com";
    await editMessageTelegram("123", 321, text, {
      cfg: { channels: { telegram: { ...cfg.channels.telegram, richMessages: true } } },
      api: bot.api,
    });
    expect(requests.at(-1)).toEqual({
      method: "editMessageText",
      fields: { chat_id: "123", message_id: 321, text },
    });
  });
});
