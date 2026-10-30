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
  const emptyMessage = "Bad Request: text must be non-empty";
  const writeForbidden = "Bad Request: CHAT_WRITE_FORBIDDEN";
  const fixture = useTelegramHttpFixture();
  const { cfg, requests, rejections, runtime, buttons } = fixture;
  const sendThrough = (
    entry: Parameters<typeof fixture.sendThrough>[0],
    text: string,
    mediaUrl?: string,
    rich = false,
    options?: Parameters<typeof fixture.sendThrough>[6],
  ) => fixture.sendThrough(entry, text, async () => {}, mediaUrl, rich, undefined, options);
  let bot: typeof fixture.bot;
  let photoPath: string;
  let photos: string[];
  let voicePath: string;
  const requestOptions = () => ({ cfg, api: bot.api });
  const mediaOptions = () => ({ ...requestOptions(), mediaLocalRoots: [fixture.mediaDir] });
  const photoOptions = () => ({ ...mediaOptions(), mediaUrl: photoPath });
  const fieldValues = (key: string, start = 0) =>
    requests.slice(start).map(({ fields }) => fields[key]);
  const expectMethods = (...methods: string[]) =>
    expect(requests.map(({ method }) => method)).toEqual(methods);
  const expectFields = (fields: Record<string, unknown[]>, start = 0) => {
    for (const [key, values] of Object.entries(fields)) {
      expect(fieldValues(key, start), key).toEqual(values);
    }
  };
  const mockAudio = (contentType: string, fileName = "clip") =>
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      buffer: Buffer.from("audio-bytes"),
      kind: "audio",
      contentType,
      fileName,
    });
  const configWith = <const T extends object>(overrides: T) => ({
    channels: { telegram: { ...cfg.channels.telegram, ...overrides } },
  });
  const expectPartial = (sending: Promise<unknown>, messageIds: string[], receipt?: unknown) =>
    expect(sending).rejects.toMatchObject({
      deliveryResult: { messageIds, ...(receipt ? { receipt } : {}) },
    });
  const hooks = (
    ...entries: Array<Pick<Parameters<typeof addTestHook>[0], "hookName" | "handler"> | false>
  ) => {
    const registry = createEmptyPluginRegistry();
    for (const entry of entries) {
      if (entry) {
        addTestHook({ registry, pluginId: "recovery", ...entry });
      }
    }
    initializeGlobalHookRunner(registry);
  };
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
      const result = await sendThrough(entry, "A".repeat(4500), undefined, true, {
        firstReply: true,
        textLimit: 32_768,
        linkPreview: false,
      });
      expectMethods("sendRichMessage", "sendMessage", "sendMessage");
      expect(requests[0]!.fields.rich_message).toMatchObject({ skip_entity_detection: true });
      expectFields(
        {
          parse_mode: [undefined, undefined],
          text: ["A".repeat(4000), "A".repeat(500)],
          reply_parameters:
            entry === "direct"
              ? [{ message_id: 7, quote: "quote", allow_sending_without_reply: true }, undefined]
              : [undefined, undefined],
          reply_markup: [undefined, { inline_keyboard: buttons }],
          link_preview_options: [{ is_disabled: true }, { is_disabled: true }],
        },
        1,
      );
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
      const result = await sendThrough("direct", text, photoPath, false, { textMode: "markdown" });
      expectMethods("sendPhoto", "sendPhoto");
      expect(fieldValues("caption")).toEqual(captions);
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
          kind === "photo" ? photoPath : undefined,
          kind === "rich",
          kind === "rich" ? {} : { threadId: 77 },
        ),
      ).rejects.toThrow(rejection);
      expectMethods(expectedMethod);
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
      await deliver([{ mediaUrl: "https://example.com/anonymous" }], {
        mediaLocalRoots: undefined,
      });
      expectMethods(method);
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
              ...mediaOptions(),
              mediaUrls: photos,
              replyToMessageId: 7,
              replyToIdSource: "implicit",
              replyToMode: "first",
              messageThreadId: 77,
              silent: true,
            });
      expectMethods("sendMediaGroup", "sendPhoto");
      const album = JSON.parse(String(requests[0]!.fields.media));
      expect(album.map((item: { caption?: string }) => item.caption)).toEqual([
        "Album",
        ...Array(9).fill(undefined),
      ]);
      expect(fieldValues("message_thread_id").map(String)).toEqual(["77", "77"]);
      expect(fieldValues("disable_notification").map(String)).toEqual(["true", "true"]);
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
      await expectPartial(
        sendMessageTelegram("123", "Album", {
          ...mediaOptions(),
          mediaUrls: photos,
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
        ids,
        { platformMessageIds: ids, threadId: "77" },
      );
      expectMethods("sendMediaGroup");
    },
  );

  it("records every accepted album part before a streaming observer can fail", async () => {
    const sequence = createTelegramPromptContextProjectionSequence({
      record: async () => {
        throw new Error("projection unavailable");
      },
    });
    const accepted = vi.fn();
    await expectPartial(
      deliver([{ mediaUrls: photos.slice(0, 2) }], {
        promptContextSequence: sequence,
        onMediaAccepted: accepted,
      }),
      ["1001", "1002"],
    );
    expect(accepted).toHaveBeenCalledExactlyOnceWith(photos.slice(0, 2));
    expectMethods("sendMediaGroup");
  });

  it.each(["photo-rejected", "unrelated-rejection"] as const)(
    "keeps album recovery and caption ordering under %s",
    async (outcome) => {
      rejections.push(
        outcome === "photo-rejected" ? "Bad Request: PHOTO_INVALID_DIMENSIONS" : writeForbidden,
      );
      if (outcome === "photo-rejected") {
        rejections.push("Bad Request: PHOTO_INVALID_DIMENSIONS");
      }
      const sending = deliver([{ text: "x".repeat(1100), mediaUrls: photos.slice(0, 2) }]);
      if (outcome === "unrelated-rejection") {
        await expect(sending).rejects.toThrow("CHAT_WRITE_FORBIDDEN");
        expectMethods("sendMediaGroup");
      } else {
        const result = await sending;
        expectMethods("sendMediaGroup", "sendPhoto", "sendDocument", "sendPhoto", "sendMessage");
        expect(requests.at(-1)!.fields.text).toBe("x".repeat(1100));
        expect(result.receipt?.platformMessageIds).toEqual(["3", "4", "5"]);
      }
    },
  );

  it.each(["text", "album"] as const)(
    "stops %s continuation on a wrong-topic acceptance without losing the receipt",
    async (kind) => {
      const accepted = (message_id: number, message_thread_id: number) => ({
        message_id,
        message_thread_id,
        date: 1700000000,
        chat: { id: 123, type: "supergroup" },
      });
      fixture.responseFor = (method) =>
        method.startsWith("send")
          ? kind === "album"
            ? [accepted(51, 77), accepted(52, 88)]
            : accepted(51, 88)
          : undefined;
      await expectPartial(
        deliver(
          [
            {
              text: "A".repeat(8000),
              ...(kind === "album" ? { mediaUrls: photos.slice(0, 2) } : {}),
            },
          ],
          { thread: { scope: "forum", id: 77 }, richMessages: false, textLimit: 32768 },
        ),
        kind === "album" ? ["51", "52"] : ["51"],
        kind === "album" ? { parts: [{ threadId: "77" }, { threadId: "88" }] } : { threadId: "88" },
      );
      expect(requests).toHaveLength(1);
    },
  );

  it("classifies migration rejection as not dispatched without rewriting the destination", async () => {
    rejections.push({
      error_code: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      parameters: { migrate_to_chat_id: -100123 },
    });
    const error = await sendThrough("public", "answer").catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({ retryable: false, message: expect.stringContaining("-100123") });
    expect(fieldValues("chat_id")).toEqual(["123"]);
  });

  it.each(["accepted", "forbidden", "unrelated", "missing-fallback", "caption-too-long"] as const)(
    "settles a voice reply with %s provider outcome and mirrors only accepted content",
    async (outcome) => {
      const overlong = outcome === "caption-too-long";
      const failure =
        outcome === "unrelated"
          ? "CHAT_WRITE_FORBIDDEN"
          : outcome === "missing-fallback"
            ? "VOICE_MESSAGES_FORBIDDEN"
            : undefined;
      hooks({
        hookName: "message_sending",
        handler: (event: { content: string }) =>
          event.content === "spoken fallback" ? { content: "Allowed fallback" } : undefined,
      });
      if (overlong) {
        rejections.push("Bad Request: caption is too long", "", emptyMessage, emptyMessage);
      } else if (outcome !== "accepted") {
        rejections.push(outcome === "unrelated" ? writeForbidden : "VOICE_MESSAGES_FORBIDDEN");
      }
      const mirror = vi.fn();
      const recordingAt: number[] = [];
      const sending = deliver(
        [
          {
            mediaUrl: voicePath,
            audioAsVoice: true,
            ...(overlong
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
      if (failure) {
        await expect(sending).rejects.toThrow(failure);
        expect(mirror).not.toHaveBeenCalled();
      } else {
        await expect(sending).resolves.toMatchObject({
          delivered: true,
          ...(overlong ? { receipt: { platformMessageIds: ["2"] } } : {}),
        });
        expect(mirror).toHaveBeenCalledExactlyOnceWith({
          text: overlong ? undefined : "Allowed fallback",
          mediaUrls: outcome === "forbidden" ? undefined : [voicePath],
        });
      }
      expect(recordingAt).toEqual([0]);
      expectMethods(
        ...(overlong
          ? ["sendVoice", "sendVoice", "sendMessage", "sendMessage"]
          : outcome === "forbidden"
            ? ["sendVoice", "sendMessage"]
            : ["sendVoice"]),
      );
      expect(requests[overlong ? 1 : 0]!.fields.caption).toBeUndefined();
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
      expectMethods("sendMessage", "pinChatMessage");
      expect(requests[1]!.fields.message_id).toBe(1);
    },
  );

  it.each(["literal", "rewrite", "blank", "rejected"] as const)(
    "reports %s content through real hooks and the prompt projection",
    async (outcome) => {
      const observed = vi.fn();
      const sent = vi.fn();
      hooks(
        { hookName: "message_sent", handler: sent },
        (outcome === "rewrite" || outcome === "blank") && {
          hookName: "message_sending",
          handler: () => ({ content: outcome === "rewrite" ? "Allowed" : "  " }),
        },
      );
      const sequence = createTelegramPromptContextProjectionSequence({
        source: { transcriptMessageId: "assistant-1" },
        record: async (record) => {
          observed(record);
          return true;
        },
      });
      if (outcome === "rejected") {
        rejections.push(writeForbidden);
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
      expect(fieldValues("text")).toEqual(
        outcome === "blank"
          ? []
          : [outcome === "rewrite" ? "Allowed" : "<code>&lt;b&gt;x&lt;/b&gt;</code>"],
      );
    },
  );
  it("keeps accepted media and voice fallback text receipts when later media is rejected", async () => {
    rejections.push("", "VOICE_MESSAGES_FORBIDDEN", "", writeForbidden);
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
    await expectPartial(sending, ["1", "3"]);
    expect(mirror).not.toHaveBeenCalled();
    expect(requests[1]!.method).toBe("sendVoice");
    expect(requests[2]!.method).toBe("sendMessage");
  });

  it.each([false, true])(
    "retains accepted media when its empty follow-up needs a keyboard retrofit (rejected: %s)",
    async (rejected) => {
      rejections.push(
        "",
        emptyMessage,
        emptyMessage,
        ...(rejected ? ["Bad Request: keyboard retrofit failed"] : []),
      );
      const sending = sendMessageTelegram("123", "\u200b".repeat(1025), {
        ...photoOptions(),
        textMode: "html",
        buttons,
      });
      if (rejected) {
        await expectPartial(sending, ["1"]);
      } else {
        await expect(sending).resolves.toMatchObject({
          messageId: "1",
          meta: { telegramHasInlineKeyboard: true },
        });
      }
      expectMethods("sendPhoto", "sendMessage", "sendMessage", "editMessageReplyMarkup");
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
        ...mediaOptions(),
        mediaUrls: [photos[0]!, photos[1]!, document, photos[2]!, photos[3]!],
        forceDocument,
      });
      expectMethods(
        ...(forceDocument
          ? Array(5).fill("sendDocument")
          : ["sendMediaGroup", "sendDocument", "sendMediaGroup"]),
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
      await sendMessageTelegram("123", "Caption", photoOptions());
      expectMethods("sendDocument");
      expect(
        Buffer.from(await resolveTelegramTestUpload(requests[0]!.fields, "document").arrayBuffer()),
      ).toEqual(await fs.readFile(photoPath));
    },
  );

  it("consumes an implicit first reply on media before its oversized caption follow-up", async () => {
    await sendMessageTelegram("123", "A".repeat(1100), {
      ...photoOptions(),
      replyToMessageId: 7,
      replyToIdSource: "implicit",
      replyToMode: "first",
    });
    expect(fieldValues("reply_to_message_id")).toEqual(["7", undefined]);
  });

  it("preserves a mismatched native venue receipt", async () => {
    fixture.responseFor = () => ({
      message_id: 303,
      message_thread_id: 100,
      chat: { id: -100123, type: "supergroup" },
    });
    await expectPartial(
      sendLocationTelegram(
        "-100123:topic:99",
        {
          latitude: 48.858844,
          longitude: 2.294351,
          name: "Eiffel Tower",
          address: "Champ de Mars",
        },
        requestOptions(),
      ),
      ["303"],
      { threadId: "100" },
    );
    expectMethods("sendVenue");
  });

  it("keeps durable voice privacy fallback context on a rich account", async () => {
    rejections.push("Bad Request: VOICE_MESSAGES_FORBIDDEN");
    await sendMessageTelegram("123:topic:77", "Hello **there**", {
      ...mediaOptions(),
      cfg: configWith({ richMessages: true }),
      mediaUrl: voicePath,
      asVoice: true,
      replyToMessageId: 7,
      silent: true,
      buttons,
    });
    expectMethods("sendVoice", "sendRichMessage");
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
        ...photoOptions(),
        cfg: configWith({ mediaMaxMb: 1 / (1024 * 1024) }),
      }),
    ).rejects.toMatchObject({ name: "ImageOptimizationLimitError", maxBytes: 1 });
    expect(requests).toEqual([]);
  });

  it("sends WAV media requested as voice using sendAudio", async () => {
    mockAudio("audio/wav", "note.wav");
    await sendMessageTelegram("123", "Caption", {
      ...requestOptions(),
      mediaUrl: "https://example.com/audio",
      asVoice: true,
    });
    expectMethods("sendAudio");
    expect(await resolveTelegramTestUpload(requests[0]!.fields, "audio").text()).toBe(
      "audio-bytes",
    );
  });

  it.each([
    { entry: "durable", method: "sendVoice", contentType: "audio/ogg", asVoice: true },
    { entry: "durable", method: "sendAudio", contentType: "audio/mpeg", asVoice: false },
    { entry: "streaming", method: "sendVoice", contentType: "audio/ogg", asVoice: true },
    { entry: "streaming", method: "sendAudio", contentType: "audio/mp4", asVoice: false },
  ] as const)(
    "sends a rounded probed duration with $entry $method uploads",
    async ({ entry, method, contentType, asVoice }) => {
      vi.spyOn(mediaRuntime, "runFfprobe").mockResolvedValue("12.6\n");
      mockAudio(contentType);
      const mediaUrl = "https://example.com/clip";
      if (entry === "durable") {
        await sendMessageTelegram("123", "", { cfg, api: bot.api, mediaUrl, asVoice });
      } else {
        await deliver([{ mediaUrl, audioAsVoice: asVoice }]);
      }
      expectMethods(method);
      expect(String(requests[0]!.fields.duration)).toBe("13");
    },
  );

  it.each(["N/A", "0", "Infinity", new Error("ffprobe unavailable")])(
    "still sends audio when duration probing yields %s",
    async (result) => {
      const probe = vi.spyOn(mediaRuntime, "runFfprobe");
      if (result instanceof Error) {
        probe.mockRejectedValue(result);
      } else {
        probe.mockResolvedValue(result);
      }
      await sendMessageTelegram("123", "", {
        cfg,
        api: bot.api,
        mediaUrl: voicePath,
        mediaLocalRoots: [fixture.mediaDir],
        asVoice: true,
      });
      expectMethods("sendVoice");
      expect(requests[0]!.fields.duration).toBeUndefined();
    },
  );

  it("does not claim delivery when all text is rejected as empty", async () => {
    const description = "text must be non-empty";
    rejections.push(`Bad Request: ${description}`, `Bad Request: ${description}`);
    await expect(sendMessageTelegram("123", "\u200b", { cfg, api: bot.api })).rejects.toThrow(
      description,
    );
    expectMethods("sendMessage", "sendMessage");
  });

  it("keeps authored link destinations through an HTML rejection", async () => {
    rejections.push("Bad Request: can't parse entities");
    await sendMessageTelegram("123", "Read [docs](https://example.com/guide)", requestOptions());
    expect(fieldValues("text")).toEqual([
      'Read <a href="https://example.com/guide">docs</a>',
      "Read docs (https://example.com/guide)",
    ]);
    const text = "[reference]: https://example.com";
    await editMessageTelegram("123", 321, text, {
      ...requestOptions(),
      cfg: configWith({ richMessages: true }),
    });
    expect(requests.at(-1)).toEqual({
      method: "editMessageText",
      fields: { chat_id: "123", message_id: 321, text },
    });
  });
});
