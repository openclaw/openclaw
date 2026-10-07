import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
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

type ReplyPayload = {
  Body: string;
  MediaPaths?: string[];
  ChannelStructuredContext?: unknown[];
} & Record<string, unknown>;
type MockWithCalls = { mock: { calls: unknown[][] } };

function mockCall(mock: MockWithCalls, index: number): unknown[] {
  const resolvedIndex = index < 0 ? mock.mock.calls.length + index : index;
  const call = mock.mock.calls[resolvedIndex];
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return call;
}

function replyPayload(replySpy: ReturnType<typeof vi.fn>, index = 0): ReplyPayload {
  const payload = mockCall(replySpy, index)[0];
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`expected reply payload ${index}`);
  }
  return payload as ReplyPayload;
}

const requireRecord = createRequireRecord("record", "expected-label-record-short");

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} array`);
  }
  return value;
}

function conversationMessages(payload: ReplyPayload): Map<unknown, Record<string, unknown>> {
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

type ScheduledTimer = {
  callback: () => unknown;
  handle: ReturnType<typeof setTimeout>;
};

function resolveActiveScheduledTimersForDelay(
  setTimeoutSpy: ReturnType<typeof vi.spyOn>,
  clearTimeoutSpy: ReturnType<typeof vi.spyOn>,
  delayMs: number,
): ScheduledTimer[] {
  const clearedHandles = new Set(
    (clearTimeoutSpy.mock.calls as Array<Parameters<typeof clearTimeout>>).map(
      ([handle]) => handle,
    ),
  );
  return (setTimeoutSpy.mock.calls as Array<Parameters<typeof setTimeout>>).flatMap(
    (call, index) => {
      if (call[1] !== delayMs) {
        return [];
      }
      const handle = setTimeoutSpy.mock.results[index]?.value as ReturnType<typeof setTimeout>;
      if (clearedHandles.has(handle) || typeof call[0] !== "function") {
        return [];
      }
      return [{ callback: call[0] as () => unknown, handle }];
    },
  );
}

async function flushActiveScheduledTimersForDelay(params: {
  setTimeoutSpy: ReturnType<typeof vi.spyOn>;
  clearTimeoutSpy: ReturnType<typeof vi.spyOn>;
  delayMs: number;
  expectedCount: number;
  enqueueSpy: Parameters<typeof runHeldTelegramBufferTimers>[1];
}) {
  const timers = resolveActiveScheduledTimersForDelay(
    params.setTimeoutSpy,
    params.clearTimeoutSpy,
    params.delayMs,
  );
  expect(timers).toHaveLength(params.expectedCount);
  for (const timer of timers) {
    clearTimeout(timer.handle);
  }
  await Promise.all(
    runHeldTelegramBufferTimers(
      timers.map((timer) => timer.callback),
      params.enqueueSpy,
    ),
  );
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
          location: {
            latitude: 48.858844,
            longitude: 2.294351,
            horizontal_accuracy: 12,
          },
        },
        assert: (payload: Record<string, unknown>) => {
          expect(payload.Body).toContain("Meet here");
          expect(payload.Body).toContain("48.858844");
          expect(payload.LocationLat).toBe(48.858844);
          expect(payload.LocationLon).toBe(2.294351);
          expect(payload.LocationSource).toBe("pin");
          expect(payload.LocationIsLive).toBe(false);
          expect(payload.ProviderUpdateId).toBe("7005");
          expect(payload.ProviderUpdateKind).toBe("message");
          expect(payload.ProviderMessageTimestamp).toBe(1736380800000);
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
          expect(payload.LocationName).toBe("Eiffel Tower");
          expect(payload.LocationAddress).toBe("Champ de Mars, Paris");
          expect(payload.LocationSource).toBe("place");
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
      const payload = replyPayload(replySpy);
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
      const originalLoadConfig = telegramBotDepsForTest.getRuntimeConfig;
      telegramBotDepsForTest.getRuntimeConfig = (() => ({
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            groupAllowFrom: ["777"],
            groupPolicy: "open",
            groups: {
              "-10042": { allowFrom: ["777"], groupPolicy: "open", requireMention: true },
            },
          },
        },
      })) as typeof telegramBotDepsForTest.getRuntimeConfig;
      const { handler, replySpy } = await createBotHandlerWithOptions({});
      const fetchSpy = mockTelegramPngDownload();
      const setTimeoutSpy = holdTelegramMediaTimeouts(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs);
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      const enqueueSpy = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue");
      const baseMessage = {
        chat: { id: -10042, type: "supergroup" as const, is_forum: true },
        from: { id: 777, is_bot: false, first_name: "Ada" },
        message_thread_id: 101,
        is_topic_message: true,
        media_group_id: "album-all-captions",
      };

      try {
        await Promise.all([
          handler({
            message: {
              ...baseMessage,
              message_id: 301,
              date: 1736380800,
              caption: "First album details 💙",
              photo: [createTelegramPhotoForTest("album-caption-1")],
            },
            me: { username: "openclaw_bot" },
            getFile: async () => ({ file_path: "photos/album-caption-1.jpg" }),
          }),
          handler({
            message: {
              ...baseMessage,
              message_id: 302,
              date: 1736380801,
              caption: laterCaption,
              caption_entities: [
                { type: entityType, offset: 0, length: laterCaption.split(" ")[0]?.length ?? 0 },
              ],
              photo: [createTelegramPhotoForTest("album-caption-2")],
            },
            me: { username: "openclaw_bot" },
            getFile: async () => ({ file_path: "photos/album-caption-2.jpg" }),
          }),
        ]);

        expect(replySpy).not.toHaveBeenCalled();
        await flushActiveScheduledTimersForDelay({
          setTimeoutSpy,
          enqueueSpy,
          clearTimeoutSpy,
          delayMs: TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
          expectedCount: 1,
        });
        expect(replySpy).toHaveBeenCalledTimes(1);
        expect(replyPayload(replySpy).Body).toContain("First album details 💙");
        expect(replyPayload(replySpy).Body).toContain(laterCaption);
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
        enqueueSpy.mockRestore();
        telegramBotDepsForTest.getRuntimeConfig = originalLoadConfig;
        fetchSpy.mockRestore();
      }
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );

  it(
    "hydrates every captioned album sibling in prompt context",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();
      const setTimeoutSpy = holdTelegramMediaTimeouts(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs);
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      const enqueueSpy = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue");
      const savedPaths = [
        "/tmp/media/inbound/album-context-1.png",
        "/tmp/media/inbound/album-context-2.png",
        "/tmp/media/inbound/album-context-3.png",
      ];

      try {
        for (const path of savedPaths) {
          setNextSavedMediaPath({ path, contentType: "image/png" });
        }

        for (const message of [
          {
            message: {
              chat: { id: 42, type: "private" as const },
              from: { id: 777, is_bot: false, first_name: "Ada" },
              message_id: 301,
              caption: "Here is the complete album",
              date: 1736380800,
              media_group_id: "album-context",
              photo: [createTelegramPhotoForTest("album-photo-1")],
            },
            getFile: async () => ({ file_path: "photos/album-context-1.png" }),
          },
          {
            message: {
              chat: { id: 42, type: "private" as const },
              from: { id: 777, is_bot: false, first_name: "Ada" },
              message_id: 302,
              date: 1736380801,
              media_group_id: "album-context",
              photo: [createTelegramPhotoForTest("album-photo-2")],
            },
            getFile: async () => ({ file_path: "photos/album-context-2.png" }),
          },
          {
            message: {
              chat: { id: 42, type: "private" as const },
              from: { id: 777, is_bot: false, first_name: "Ada" },
              message_id: 303,
              date: 1736380802,
              media_group_id: "album-context",
              photo: [createTelegramPhotoForTest("album-photo-3")],
            },
            getFile: async () => ({ file_path: "photos/album-context-3.png" }),
          },
        ]) {
          await handler({
            message: message.message,
            me: { username: "openclaw_bot" },
            getFile: message.getFile,
          });
        }

        await flushActiveScheduledTimersForDelay({
          setTimeoutSpy,
          enqueueSpy,
          clearTimeoutSpy,
          delayMs: TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
          expectedCount: 1,
        });
        expect(replySpy).toHaveBeenCalledTimes(1);

        expect(runtimeError).not.toHaveBeenCalled();
        const payload = replyPayload(replySpy);
        expect(payload.Body).toContain("Here is the complete album");
        expect(payload.MediaPaths).toEqual(savedPaths);
        const messagesById = conversationMessages(payload);
        expect(messagesById.get("302")?.media_path).toBe("media://inbound/album-context-2.png");
        expect(messagesById.get("302")?.media_ref).toBeUndefined();
        expect(messagesById.get("303")?.media_path).toBe("media://inbound/album-context-3.png");
        expect(messagesById.get("303")?.media_ref).toBeUndefined();
      } finally {
        for (const timer of resolveActiveScheduledTimersForDelay(
          setTimeoutSpy,
          clearTimeoutSpy,
          TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
        )) {
          clearTimeout(timer.handle);
        }
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
        enqueueSpy.mockRestore();
        fetchSpy.mockRestore();
      }
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );
  it(
    "buffers separate media groups independently",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();
      const setTimeoutSpy = holdTelegramMediaTimeouts(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs);
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      const enqueueSpy = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue");

      try {
        const messages = [
          {
            chat: { id: 42, type: "private" as const },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            message_id: 111,
            caption: "Album A",
            date: 1736380800,
            media_group_id: "albumA",
            photo: [createTelegramPhotoForTest("photoA1")],
            filePath: "photos/photoA1.jpg",
          },
          {
            chat: { id: 42, type: "private" as const },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            message_id: 112,
            caption: "Album B",
            date: 1736380801,
            media_group_id: "albumB",
            photo: [createTelegramPhotoForTest("photoB1")],
            filePath: "photos/photoB1.jpg",
          },
        ];
        await Promise.all(
          messages.map((message) =>
            handler({
              message,
              me: { username: "openclaw_bot" },
              getFile: async () => ({ file_path: message.filePath }),
            }),
          ),
        );

        expect(replySpy).not.toHaveBeenCalled();
        await flushActiveScheduledTimersForDelay({
          setTimeoutSpy,
          enqueueSpy,
          clearTimeoutSpy,
          delayMs: TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
          expectedCount: 2,
        });
        expect(replySpy).toHaveBeenCalledTimes(2);
        expect(runtimeError).not.toHaveBeenCalled();
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
        enqueueSpy.mockRestore();
        fetchSpy.mockRestore();
      }
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );
  it(
    "omits skipped album siblings from prompt context",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const setTimeoutSpy = holdTelegramMediaTimeouts(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs);
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      const enqueueSpy = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue");
      const savedPaths = [
        "/tmp/media/inbound/album-partial-2.png",
        "/tmp/media/inbound/album-partial-3.png",
      ];
      const pngBytes = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

      readRemoteMediaBufferSpy.mockImplementation(
        async (params: { url?: string; filePathHint?: string }) => {
          const url = params.url ?? "";
          if (url.includes("album-partial-1.png")) {
            throw new Error(`Telegram media exceeds 20 MB limit: ${url}`);
          }
          return {
            buffer: pngBytes,
            contentType: "image/png",
            fileName: params.filePathHint,
          };
        },
      );

      try {
        for (const path of savedPaths) {
          setNextSavedMediaPath({ path, contentType: "image/png" });
        }

        for (const message of [
          {
            message: {
              chat: { id: 42, type: "private" as const },
              from: { id: 777, is_bot: false, first_name: "Ada" },
              message_id: 501,
              date: 1736380800,
              media_group_id: "album-partial-context",
              photo: [createTelegramPhotoForTest("album-partial-photo-1")],
            },
            getFile: async () => ({ file_path: "photos/album-partial-1.png" }),
          },
          {
            message: {
              chat: { id: 42, type: "private" as const },
              from: { id: 777, is_bot: false, first_name: "Ada" },
              message_id: 502,
              caption: "Here is a partial album",
              date: 1736380801,
              media_group_id: "album-partial-context",
              photo: [createTelegramPhotoForTest("album-partial-photo-2")],
            },
            getFile: async () => ({ file_path: "photos/album-partial-2.png" }),
          },
          {
            message: {
              chat: { id: 42, type: "private" as const },
              from: { id: 777, is_bot: false, first_name: "Ada" },
              message_id: 503,
              date: 1736380802,
              media_group_id: "album-partial-context",
              photo: [createTelegramPhotoForTest("album-partial-photo-3")],
            },
            getFile: async () => ({ file_path: "photos/album-partial-3.png" }),
          },
        ]) {
          await handler({
            message: message.message,
            me: { username: "openclaw_bot" },
            getFile: message.getFile,
          });
        }

        await flushActiveScheduledTimersForDelay({
          setTimeoutSpy,
          enqueueSpy,
          clearTimeoutSpy,
          delayMs: TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
          expectedCount: 1,
        });
        expect(replySpy).toHaveBeenCalledTimes(1);

        expect(runtimeError).not.toHaveBeenCalled();
        const payload = replyPayload(replySpy);
        expect(payload.Body).toContain("Here is a partial album");
        expect(payload.MediaPaths).toEqual(savedPaths);
        const messagesById = conversationMessages(payload);
        expect(messagesById.get("501")).toBeUndefined();
        expect(messagesById.get("503")?.media_path).toBe("media://inbound/album-partial-3.png");
        expect(messagesById.get("503")?.media_ref).toBeUndefined();
        expect(JSON.stringify(payload.ChannelStructuredContext)).not.toContain(
          "telegram:file/album-partial-photo-1",
        );
      } finally {
        for (const timer of resolveActiveScheduledTimersForDelay(
          setTimeoutSpy,
          clearTimeoutSpy,
          TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
        )) {
          clearTimeout(timer.handle);
        }
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
        enqueueSpy.mockRestore();
      }
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );

  it(
    "buffers same-id forum topic media groups independently",
    async () => {
      const originalLoadConfig = telegramBotDepsForTest.getRuntimeConfig;
      telegramBotDepsForTest.getRuntimeConfig = (() => ({
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            groupAllowFrom: ["777"],
            groupPolicy: "open",
            groups: {
              "-10042": { allowFrom: ["777"], groupPolicy: "open", requireMention: false },
            },
          },
        },
      })) as typeof telegramBotDepsForTest.getRuntimeConfig;

      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();
      const setTimeoutSpy = holdTelegramMediaTimeouts(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs);
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      const enqueueSpy = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue");

      try {
        await Promise.all([
          handler({
            message: {
              chat: { id: -10042, type: "supergroup" as const, is_forum: true },
              from: { id: 777, is_bot: false, first_name: "Ada" },
              message_id: 131,
              message_thread_id: 101,
              is_topic_message: true,
              caption: "@openclaw_bot Topic one album",
              date: 1736380800,
              media_group_id: "album-shared-by-telegram",
              photo: [createTelegramPhotoForTest("topic1photo")],
            },
            me: { username: "openclaw_bot" },
            getFile: async () => ({ file_path: "photos/topic1.jpg" }),
          }),
          handler({
            message: {
              chat: { id: -10042, type: "supergroup" as const, is_forum: true },
              from: { id: 777, is_bot: false, first_name: "Ada" },
              message_id: 132,
              message_thread_id: 202,
              is_topic_message: true,
              caption: "@openclaw_bot Topic two album",
              date: 1736380801,
              media_group_id: "album-shared-by-telegram",
              photo: [createTelegramPhotoForTest("topic2photo")],
            },
            me: { username: "openclaw_bot" },
            getFile: async () => ({ file_path: "photos/topic2.jpg" }),
          }),
        ]);

        await flushActiveScheduledTimersForDelay({
          setTimeoutSpy,
          enqueueSpy,
          clearTimeoutSpy,
          delayMs: TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
          expectedCount: 2,
        });
        expect(replySpy).toHaveBeenCalledTimes(2);
        const firstPayload = replyPayload(replySpy, 0);
        const secondPayload = replyPayload(replySpy, 1);
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
        for (const timer of resolveActiveScheduledTimersForDelay(
          setTimeoutSpy,
          clearTimeoutSpy,
          TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
        )) {
          clearTimeout(timer.handle);
        }
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
        enqueueSpy.mockRestore();
        fetchSpy.mockRestore();
        telegramBotDepsForTest.getRuntimeConfig = originalLoadConfig;
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
      const setTimeoutSpy = holdTelegramMediaTimeouts(forwardWindowMs);
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      // The debouncer discards its flush promise; the delivered turn is the completion signal.
      const elapseForwardWindow = () => {
        const timers = resolveActiveScheduledTimersForDelay(
          setTimeoutSpy,
          clearTimeoutSpy,
          forwardWindowMs,
        );
        for (const timer of timers) {
          clearTimeout(timer.handle);
          timer.callback();
        }
        return timers.length;
      };
      // Telegram attachment downloads routinely outlast the forward quiet window.
      readRemoteMediaBufferSpy.mockImplementation(async () => {
        elapseForwardWindow();
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

      try {
        await handler({
          message: {
            chat: { id: 42, type: "private" },
            from: { id: 777, is_bot: false, first_name: "N" },
            message_id: 21,
            text: "Look at this",
            date: 1736380800,
            forward_origin: { type: "hidden_user", date: 1736380700, sender_user_name: "A" },
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        await handler({
          message: {
            chat: { id: 42, type: "private" },
            from: { id: 777, is_bot: false, first_name: "N" },
            message_id: 22,
            date: 1736380801,
            photo: [createTelegramPhotoForTest("fwd_photo_1")],
            forward_origin: { type: "hidden_user", date: 1736380701, sender_user_name: "A" },
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({ file_path: "photos/fwd1.jpg" }),
        });
        expect(elapseForwardWindow()).toBe(1);

        const payload = await deliveredTurn.promise;
        expect(payload.Body).toContain("Look at this");
        expect(payload.MediaPaths).toHaveLength(1);
        expect(mediaHarnessReplySpy).toHaveBeenCalledTimes(1);
        expect(runtimeError).not.toHaveBeenCalled();
      } finally {
        mediaHarnessReplySpy.mockReset();
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
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
          groups: {
            "-10042": { groupPolicy: "open", requireMention: false },
          },
        },
      },
    });
    telegramMediaHarnessSendMessageSpy.mockClear();
  });
  it.each([
    {
      description: "forum topic",
      chat: { id: -10042, type: "supergroup" as const, is_forum: true },
      threadId: 202,
      expectedThreadId: 202,
      failure: new Error("Telegram media exceeds 20 MB limit"),
      expectedWarning: "File too large",
      expectedNotice: "[media unavailable: file exceeds 8MB limit]",
    },
    {
      description: "bot DM topic",
      chat: { id: 4242, type: "private" as const },
      threadId: 303,
      expectedThreadId: 303,
      failure: new Error("Telegram media exceeds 20 MB limit"),
      expectedWarning: "File too large",
      expectedNotice: "[media unavailable: file exceeds 8MB limit]",
    },
    {
      description: "forum General topic",
      chat: { id: -10042, type: "supergroup" as const, is_forum: true },
      threadId: 1,
      expectedThreadId: undefined,
      failure: new Error("Telegram media exceeds 20 MB limit"),
      expectedWarning: "File too large",
      expectedNotice: "[media unavailable: file exceeds 8MB limit]",
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
        message: {
          chat,
          from: { id: 777, is_bot: false, first_name: "Ada" },
          message_id: 901,
          message_thread_id: threadId,
          is_topic_message: true,
          caption: "Topic attachment",
          date: 1736380800,
          photo: [createTelegramPhotoForTest("topic-attachment")],
        },
        me: { username: "openclaw_bot", has_topics_enabled: true },
        getFile: async () => ({ file_path: "photos/topic-attachment.jpg" }),
      });

      expect(telegramMediaHarnessSendMessageSpy).toHaveBeenCalledWith(
        chat.id,
        expect.stringContaining(expectedWarning),
        expect.objectContaining({
          reply_parameters: expect.objectContaining({ message_id: 901 }),
        }),
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
    const handler = onSpy.mock.calls.find(([event]) => event === "channel_post")?.[1];
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
    const enqueueSpy = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue");
    try {
      mockTelegramPngDownload();
      for (let index = 0; index < 2; index++) {
        readRemoteMediaBufferSpy.mockRejectedValueOnce(
          new Error("Telegram media exceeds 8 MB limit"),
        );
      }
      for (let index = 0; index < 2; index++) {
        await handler({
          message: {
            chat: { id: 4242, type: "private" },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            message_id: 910 + index,
            date: 1736380800,
            media_group_id: "failure-notice-album",
            ...(index === 0 ? { caption: "Album attachment" } : {}),
            photo: [createTelegramPhotoForTest(`album-${index}`)],
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({ file_path: `photos/album-${index}.jpg` }),
        });
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
        expect.objectContaining({
          reply_parameters: expect.objectContaining({ message_id: 910 }),
        }),
      ]);
    } finally {
      setTimeoutSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });
});
