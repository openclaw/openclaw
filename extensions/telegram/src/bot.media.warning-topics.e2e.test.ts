import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as keyedAsyncQueue from "openclaw/plugin-sdk/keyed-async-queue";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushChannelPostMediaGroup,
  holdTelegramMediaTimeouts,
  runHeldTelegramBufferTimers,
} from "./bot-media-timers.test-support.js";
import {
  mediaHarnessReplySpy,
  onSpy,
  readRemoteMediaBufferSpy,
  setNextSavedMediaPath,
  telegramBotDepsForTest,
  telegramMediaHarnessSendMessageSpy,
} from "./bot.media.e2e.test-harness.js";
import {
  TELEGRAM_TEST_TIMINGS,
  createBotHandler,
  createBotHandlerWithOptions,
  createTelegramPhotoForTest,
  mockTelegramPngDownload,
} from "./bot.media.test-utils.js";

function replyPayload(index = 0): MsgContext {
  return expectDefined(mediaHarnessReplySpy.mock.calls.at(index)?.[0], "reply payload");
}

const requireRecord = createRequireRecord("record", "expected-label-record-short");

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} array`);
  }
  return value;
}

function conversationMessages(payload: MsgContext): Map<unknown, Record<string, unknown>> {
  const [conversationContext] = requireArray(
    payload.ChannelStructuredContext,
    "structured context",
  );
  const contextRecord = requireRecord(conversationContext, "conversation context");
  const contextPayload = requireRecord(contextRecord.payload, "conversation context payload");
  const messages = requireArray(contextPayload.messages, "conversation context messages").map(
    (message, index) => requireRecord(message, `conversation context message ${index + 1}`),
  );
  return new Map(messages.map((message) => [message.message_id, message]));
}

function mediaContext(
  messageId: number,
  fileId: string,
  filePath: string,
  message: Record<string, unknown> = {},
) {
  return {
    message: {
      chat: { id: 42, type: "private" },
      from: { id: 777, is_bot: false, first_name: "Ada" },
      message_id: messageId,
      date: 1736380800,
      photo: [createTelegramPhotoForTest(fileId)],
      ...message,
    },
    me: { username: "openclaw_bot" },
    getFile: async () => ({ file_path: filePath }),
  };
}

function holdMediaGroup(delayMs: number = TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs) {
  const setTimeoutSpy = holdTelegramMediaTimeouts(delayMs);
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
  const enqueueSpy = vi.spyOn(keyedAsyncQueue, "enqueueKeyedTask");
  const active = () => {
    const cleared = new Set(clearTimeoutSpy.mock.calls.map(([handle]) => handle));
    return setTimeoutSpy.mock.calls.flatMap(([callback, delay], index) => {
      const handle = setTimeoutSpy.mock.results[index]?.value as ReturnType<typeof setTimeout>;
      return delay === delayMs && !cleared.has(handle) && typeof callback === "function"
        ? [{ callback: callback as () => unknown, handle }]
        : [];
    });
  };
  return {
    async flush(expectedCount: number) {
      const timers = active();
      expect(timers).toHaveLength(expectedCount);
      for (const { handle } of timers) {
        clearTimeout(handle);
      }
      await Promise.all(
        runHeldTelegramBufferTimers(
          timers.map((timer) => timer.callback),
          enqueueSpy,
        ),
      );
    },
    elapse() {
      const timers = active();
      for (const { handle, callback } of timers) {
        clearTimeout(handle);
        callback();
      }
      return timers.length;
    },
    restore(clearPending = false) {
      if (clearPending) {
        for (const { handle } of active()) {
          clearTimeout(handle);
        }
      }
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      enqueueSpy.mockRestore();
    },
  };
}

function configureForum(requireMention: boolean) {
  const original = telegramBotDepsForTest.getRuntimeConfig;
  telegramBotDepsForTest.getRuntimeConfig = () => ({
    channels: {
      telegram: {
        dmPolicy: "open",
        allowFrom: ["*"],
        groupAllowFrom: ["777"],
        groupPolicy: "open",
        groups: { "-10042": { allowFrom: ["777"], groupPolicy: "open", requireMention } },
      },
    },
  });
  return () => {
    telegramBotDepsForTest.getRuntimeConfig = original;
  };
}

describe("telegram inbound media", () => {
  it("captures pin and venue location payload fields", async () => {
    const { handler, replySpy } = await createBotHandler();

    const cases = [
      {
        updateId: 7005,
        message: {
          chat: { id: 42, type: "private" as const },
          message_id: 5,
          caption: "Meet here",
          date: 1736380800,
          location: { latitude: 48.858844, longitude: 2.294351, horizontal_accuracy: 12 },
        },
        assert: (payload: Record<string, unknown>) => {
          expect(payload.Body).toContain("Meet here");
          expect(payload.Body).toContain("48.858844");
          expect(payload).toMatchObject({
            LocationLat: 48.858844,
            LocationLon: 2.294351,
            LocationSource: "pin",
            LocationIsLive: false,
            ProviderUpdateId: "7005",
            ProviderUpdateKind: "message",
            ProviderMessageTimestamp: 1736380800000,
          });
        },
      },
      {
        updateId: 7006,
        message: {
          chat: { id: 42, type: "private" as const },
          message_id: 6,
          date: 1736380800,
          venue: {
            title: "Eiffel Tower",
            address: "Champ de Mars, Paris",
            location: { latitude: 48.858844, longitude: 2.294351 },
          },
        },
        assert: (payload: Record<string, unknown>) => {
          expect(payload.Body).toContain("48.858844");
          expect(payload).toMatchObject({
            LocationName: "Eiffel Tower",
            LocationAddress: "Champ de Mars, Paris",
            LocationSource: "place",
          });
        },
      },
    ] as const;

    for (const testCase of cases) {
      replySpy.mockClear();
      await handler({
        update: { update_id: testCase.updateId, message: testCase.message },
        message: testCase.message,
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "unused" }),
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replyPayload();
      testCase.assert(payload);
    }
  });
});
describe("telegram media groups", () => {
  afterEach(() => {
    vi.clearAllTimers();
  });

  const MEDIA_GROUP_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;

  it(
    "preserves captions and a later mention from every message in a forum album",
    async () => {
      const laterCaption = "@openclaw_bot second album details";
      const entityType = "mention";
      const restoreConfig = configureForum(true);
      const { handler, replySpy } = await createBotHandlerWithOptions({});
      const fetchSpy = mockTelegramPngDownload();
      const timers = holdMediaGroup();
      const baseMessage = {
        chat: { id: -10042, type: "supergroup" as const, is_forum: true },
        from: { id: 777, is_bot: false, first_name: "Ada" },
        message_thread_id: 101,
        is_topic_message: true,
        media_group_id: "album-all-captions",
      };

      try {
        await Promise.all([
          handler(
            mediaContext(301, "album-caption-1", "photos/album-caption-1.jpg", {
              ...baseMessage,
              caption: "First album details 💙",
            }),
          ),
          handler(
            mediaContext(302, "album-caption-2", "photos/album-caption-2.jpg", {
              ...baseMessage,
              date: 1736380801,
              caption: laterCaption,
              caption_entities: [
                { type: entityType, offset: 0, length: laterCaption.split(" ")[0]?.length ?? 0 },
              ],
            }),
          ),
        ]);

        expect(replySpy).not.toHaveBeenCalled();
        await timers.flush(1);
        expect(replySpy).toHaveBeenCalledTimes(1);
        expect(replyPayload().Body).toContain("First album details 💙");
        expect(replyPayload().Body).toContain(laterCaption);
      } finally {
        timers.restore();
        restoreConfig();
        fetchSpy.mockRestore();
      }
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );

  it.each([
    {
      name: "hydrates every captioned",
      partial: false,
      firstId: 301,
      file: "album-context",
      photo: "album-photo",
      caption: "Here is the complete album",
    },
    {
      name: "omits skipped",
      partial: true,
      firstId: 501,
      file: "album-partial",
      photo: "album-partial-photo",
      caption: "Here is a partial album",
    },
  ])(
    "$name album siblings in prompt context",
    async ({ partial, firstId, file, photo, caption }) => {
      const { handler, replySpy, runtimeError } = await createBotHandler();
      const fetchSpy = partial ? undefined : mockTelegramPngDownload();
      const timers = holdMediaGroup();
      const savedPaths = (partial ? [2, 3] : [1, 2, 3]).map(
        (index) => `/tmp/media/inbound/${file}-${index}.png`,
      );
      if (partial) {
        readRemoteMediaBufferSpy.mockImplementation(
          async (params: { url?: string; filePathHint?: string }) => {
            if (params.url?.includes("album-partial-1.png")) {
              throw new Error(`Telegram media exceeds 20 MB limit: ${params.url}`);
            }
            return {
              buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
              contentType: "image/png",
              fileName: params.filePathHint,
            };
          },
        );
      }
      try {
        for (const path of savedPaths) {
          setNextSavedMediaPath({ path, contentType: "image/png" });
        }
        for (const index of [1, 2, 3]) {
          await handler(
            mediaContext(firstId + index - 1, `${photo}-${index}`, `photos/${file}-${index}.png`, {
              date: 1736380800 + index - 1,
              media_group_id: partial ? "album-partial-context" : "album-context",
              ...(index === (partial ? 2 : 1) ? { caption } : {}),
            }),
          );
        }
        await timers.flush(1);
        expect(replySpy).toHaveBeenCalledTimes(1);
        expect(runtimeError).not.toHaveBeenCalled();
        const payload = replyPayload();
        expect(payload).toMatchObject({
          Body: expect.stringContaining(caption),
          MediaPaths: savedPaths,
        });
        const messages = conversationMessages(payload);
        for (const index of partial ? [3] : [2, 3]) {
          expect(messages.get(String(firstId + index - 1))?.media_path).toBe(
            `media://inbound/${file}-${index}.png`,
          );
          expect(messages.get(String(firstId + index - 1))?.media_ref).toBeUndefined();
        }
        if (partial) {
          expect(messages.get("501")).toBeUndefined();
          expect(JSON.stringify(payload.ChannelStructuredContext)).not.toContain(
            "telegram:file/album-partial-photo-1",
          );
        }
      } finally {
        timers.restore(true);
        fetchSpy?.mockRestore();
      }
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );

  it(
    "buffers separate media groups independently",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();
      const fetchSpy = mockTelegramPngDownload();
      const timers = holdMediaGroup();

      try {
        await Promise.all(
          ["A", "B"].map((name, index) => {
            const fileId = `photo${name}1`;
            return handler(
              mediaContext(111 + index, fileId, `photos/${fileId}.jpg`, {
                caption: `Album ${name}`,
                date: 1736380800 + index,
                media_group_id: `album${name}`,
                filePath: `photos/${fileId}.jpg`,
              }),
            );
          }),
        );

        expect(replySpy).not.toHaveBeenCalled();
        await timers.flush(2);
        expect(replySpy).toHaveBeenCalledTimes(2);
        expect(runtimeError).not.toHaveBeenCalled();
      } finally {
        timers.restore();
        fetchSpy.mockRestore();
      }
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );
  it(
    "buffers same-id forum topic media groups independently",
    async () => {
      const restoreConfig = configureForum(false);

      const { handler, replySpy, runtimeError } = await createBotHandler();
      const fetchSpy = mockTelegramPngDownload();
      const timers = holdMediaGroup();

      try {
        await Promise.all(
          [101, 202].map((threadId, index) =>
            handler(
              mediaContext(131 + index, `topic${index + 1}photo`, `photos/topic${index + 1}.jpg`, {
                chat: { id: -10042, type: "supergroup", is_forum: true },
                message_thread_id: threadId,
                is_topic_message: true,
                caption: `@openclaw_bot Topic ${index === 0 ? "one" : "two"} album`,
                date: 1736380800 + index,
                media_group_id: "album-shared-by-telegram",
              }),
            ),
          ),
        );

        await timers.flush(2);
        expect(replySpy).toHaveBeenCalledTimes(2);
        const firstPayload = replyPayload(0);
        const secondPayload = replyPayload(1);
        expect([firstPayload.Body, secondPayload.Body]).toEqual(
          expect.arrayContaining([
            expect.stringContaining("Topic one album"),
            expect.stringContaining("Topic two album"),
          ]),
        );
        expect(firstPayload.MediaPaths).toHaveLength(1);
        expect(secondPayload.MediaPaths).toHaveLength(1);
        expect(runtimeError).not.toHaveBeenCalled();
      } finally {
        timers.restore(true);
        fetchSpy.mockRestore();
        restoreConfig();
      }
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );

  it(
    "coalesces forwarded text + forwarded attachment into a single processing turn with default debounce config",
    async () => {
      const forwardWindowMs = 1_000;
      const deliveredTurn = createDeferred<MsgContext>();
      const runtimeError = vi.fn((error: unknown) => deliveredTurn.reject(error));
      const { handler } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();
      // The burst deadline reads performance; freeze it so the held window keeps its delay.
      vi.useFakeTimers({ toFake: ["performance"] });
      const timers = holdMediaGroup(forwardWindowMs);
      // The debouncer discards its flush promise; the delivered turn signals completion.
      // Telegram attachment downloads routinely outlast the forward quiet window.
      readRemoteMediaBufferSpy.mockImplementation(async () => {
        timers.elapse();
        return {
          buffer: Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
          contentType: "image/png",
          fileName: "fwd1.png",
        };
      });
      mediaHarnessReplySpy.mockImplementation(async (ctx, opts) => {
        await opts?.onReplyStart?.();
        deliveredTurn.resolve(ctx);
        return undefined;
      });
      const forwarded = (messageId: number, message: Record<string, unknown>) =>
        mediaContext(messageId, "fwd_photo_1", "photos/fwd1.jpg", {
          from: { id: 777, is_bot: false, first_name: "N" },
          date: 1736380779 + messageId,
          forward_origin: {
            type: "hidden_user",
            date: 1736380679 + messageId,
            sender_user_name: "A",
          },
          ...message,
        });

      try {
        await handler({
          ...forwarded(21, { text: "Look at this", photo: undefined }),
          getFile: async () => ({}),
        });
        await handler(forwarded(22, {}));
        expect(timers.elapse()).toBe(1);

        const payload = await deliveredTurn.promise;
        expect(payload.Body).toContain("Look at this");
        expect(payload.MediaPaths).toHaveLength(1);
        expect(mediaHarnessReplySpy).toHaveBeenCalledTimes(1);
        expect(runtimeError).not.toHaveBeenCalled();
      } finally {
        mediaHarnessReplySpy.mockReset();
        timers.restore();
        vi.useRealTimers();
        fetchSpy.mockRestore();
      }
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );
});

describe("Telegram media failure notices", () => {
  beforeEach(() => {
    telegramBotDepsForTest.getRuntimeConfig = () => ({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groupAllowFrom: ["777", "-10042"],
          groupPolicy: "open",
          mediaMaxMb: 8,
          groups: { "-10042": { groupPolicy: "open", requireMention: false } },
        },
      },
    });
    telegramMediaHarnessSendMessageSpy.mockClear();
  });
  const oversize = {
    failure: new Error("Telegram media exceeds 20 MB limit"),
    expectedWarning: "File too large",
    expectedNotice: "[media unavailable: file exceeds 8MB limit]",
  };
  it.each([
    {
      description: "forum topic",
      chat: { id: -10042, type: "supergroup" as const, is_forum: true },
      threadId: 202,
      expectedThreadId: 202,
      ...oversize,
    },
    {
      description: "bot DM topic",
      chat: { id: 4242, type: "private" as const },
      threadId: 303,
      expectedThreadId: 303,
      ...oversize,
    },
    {
      description: "forum General topic",
      chat: { id: -10042, type: "supergroup" as const, is_forum: true },
      threadId: 1,
      expectedThreadId: undefined,
      ...oversize,
    },
    {
      description: "forum topic after an ordinary download failure",
      chat: { id: -10042, type: "supergroup" as const, is_forum: true },
      threadId: 404,
      expectedThreadId: 404,
      failure: new Error("permanent download failure"),
      expectedWarning: "Failed to download media",
      expectedNotice: "[media unavailable: download failed]",
    },
  ])(
    "keeps $description warnings in their originating Telegram thread",
    async ({ chat, threadId, expectedThreadId, failure, expectedWarning, expectedNotice }) => {
      const { handler, replySpy } = await createBotHandlerWithOptions({});
      telegramMediaHarnessSendMessageSpy.mockClear();
      readRemoteMediaBufferSpy.mockRejectedValueOnce(failure);

      await handler({
        ...mediaContext(901, "topic-attachment", "photos/topic-attachment.jpg", {
          chat,
          message_thread_id: threadId,
          is_topic_message: true,
          caption: "Topic attachment",
        }),
        me: { username: "openclaw_bot", has_topics_enabled: true },
      });

      expect(telegramMediaHarnessSendMessageSpy).toHaveBeenCalledWith(
        chat.id,
        expect.stringContaining(expectedWarning),
        expect.objectContaining({ reply_parameters: expect.objectContaining({ message_id: 901 }) }),
      );
      const warning = telegramMediaHarnessSendMessageSpy.mock.calls.find(
        ([, text]) => typeof text === "string" && text.includes(expectedWarning),
      );
      if (!warning) {
        throw new Error(`Missing ${expectedWarning} Telegram media warning`);
      }
      const options = warning[2] as { message_thread_id?: number };
      expect(options.message_thread_id).toBe(expectedThreadId);
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        Body: expect.stringContaining(expectedNotice),
        BodyForAgent: `Topic attachment\n\n${expectedNotice}`,
        RawBody: "Topic attachment",
        CommandBody: "Topic attachment",
      });
    },
  );

  it("keeps channel-post oversize warnings suppressed (failure=false)", async () => {
    const { replySpy } = await createBotHandlerWithOptions({});
    const handler = onSpy.mock.calls.find(([filter]) =>
      Array.isArray(filter) ? filter.includes("channel_post") : filter === "channel_post",
    )?.[1];
    mockTelegramPngDownload();
    await handler({
      channelPost: {
        chat: { id: -10042, type: "channel", title: "Announcements" },
        sender_chat: { id: -10042, type: "channel", title: "Announcements" },
        message_id: 902,
        date: 1736380800,
        caption: "Channel attachment",
        photo: [createTelegramPhotoForTest("channel-attachment")],
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ file_path: "photos/channel-attachment.jpg" }),
    });
    expect(telegramMediaHarnessSendMessageSpy).not.toHaveBeenCalled();
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      BodyForAgent: "Channel attachment",
      RawBody: "Channel attachment",
      CommandBody: "Channel attachment",
    });
    expect(payload.Body).not.toContain("[media unavailable:");
  });

  it("accounts for 2 failed attachments in an album", async () => {
    const { handler, replySpy } = await createBotHandlerWithOptions({});
    const setTimeoutSpy = holdTelegramMediaTimeouts(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs);
    const enqueueSpy = vi.spyOn(keyedAsyncQueue, "enqueueKeyedTask");
    try {
      mockTelegramPngDownload();
      for (let index = 0; index < 2; index++) {
        readRemoteMediaBufferSpy.mockRejectedValueOnce(
          new Error("Telegram media exceeds 8 MB limit"),
        );
      }
      for (let index = 0; index < 2; index++) {
        await handler(
          mediaContext(910 + index, `album-${index}`, `photos/album-${index}.jpg`, {
            chat: { id: 4242, type: "private" },
            media_group_id: "failure-notice-album",
            ...(index === 0 ? { caption: "Album attachment" } : {}),
          }),
        );
      }
      await flushChannelPostMediaGroup(
        setTimeoutSpy,
        enqueueSpy,
        0,
        TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
      );
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0]?.[0];
      expect(payload).toMatchObject({
        BodyForAgent:
          "Album attachment\n\n[media unavailable: 2 of 2 attachments could not be downloaded]",
        RawBody: "Album attachment",
        CommandBody: "Album attachment",
      });
      expect(payload.Body).toContain("[media unavailable:");
      expect(payload.media.filter((media: { path?: string }) => media.path)).toHaveLength(0);
      const warnings = telegramMediaHarnessSendMessageSpy.mock.calls.filter(
        ([, text]) => typeof text === "string" && text.includes(" of 2 images"),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toEqual([
        4242,
        expect.stringContaining("0 of 2 images"),
        expect.objectContaining({ reply_parameters: expect.objectContaining({ message_id: 910 }) }),
      ]);
    } finally {
      setTimeoutSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });
});
