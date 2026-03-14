import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_TEST_TIMINGS,
  cacheStickerSpy,
  createBotHandler,
  createBotHandlerWithOptions,
  describeStickerImageSpy,
  getCachedStickerSpy,
  mockTelegramFileDownload,
} from "./bot.media.test-utils.js";

describe("telegram stickers", () => {
  const STICKER_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 20_000;

  beforeEach(() => {
    cacheStickerSpy.mockClear();
    getCachedStickerSpy.mockClear();
    describeStickerImageSpy.mockClear();
    // Re-seed defaults so per-test overrides do not leak when using mockClear.
    getCachedStickerSpy.mockReturnValue(undefined);
    describeStickerImageSpy.mockReturnValue(undefined);
  });

  it(
    "downloads static sticker (WEBP) and includes sticker metadata",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();
      const fetchSpy = mockTelegramFileDownload({
        contentType: "image/webp",
        bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]), // RIFF header
      });

      await handler({
        message: {
          message_id: 100,
          chat: { id: 1234, type: "private" },
          sticker: {
            file_id: "sticker_file_id_123",
            file_unique_id: "sticker_unique_123",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: false,
            is_video: false,
            emoji: "🎉",
            set_name: "TestStickerPack",
          },
          date: 1736380800,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "stickers/sticker.webp" }),
      });

      expect(runtimeError).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.telegram.org/file/bottok/stickers/sticker.webp",
        expect.objectContaining({ redirect: "manual" }),
      );
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      expect(payload.Body).toContain("<media:sticker>");
      expect(payload.Sticker?.emoji).toBe("🎉");
      expect(payload.Sticker?.setName).toBe("TestStickerPack");
      expect(payload.Sticker?.fileId).toBe("sticker_file_id_123");

      fetchSpy.mockRestore();
    },
    STICKER_TEST_TIMEOUT_MS,
  );

  it(
    "refreshes cached sticker metadata on cache hit",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();

      getCachedStickerSpy.mockReturnValue({
        fileId: "old_file_id",
        fileUniqueId: "sticker_unique_456",
        emoji: "😴",
        setName: "OldSet",
        description: "Cached description",
        cachedAt: "2026-01-20T10:00:00.000Z",
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "image/webp" },
        arrayBuffer: async () => new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer,
      } as unknown as Response);

      await handler({
        message: {
          message_id: 103,
          chat: { id: 1234, type: "private" },
          sticker: {
            file_id: "new_file_id",
            file_unique_id: "sticker_unique_456",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: false,
            is_video: false,
            emoji: "🔥",
            set_name: "NewSet",
          },
          date: 1736380800,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "stickers/sticker.webp" }),
      });

      expect(runtimeError).not.toHaveBeenCalled();
      expect(cacheStickerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          fileId: "new_file_id",
          emoji: "🔥",
          setName: "NewSet",
        }),
      );
      const payload = replySpy.mock.calls[0][0];
      expect(payload.Sticker?.fileId).toBe("new_file_id");
      expect(payload.Sticker?.cachedDescription).toBe("Cached description");

      fetchSpy.mockRestore();
    },
    STICKER_TEST_TIMEOUT_MS,
  );

  it(
    "skips animated and video sticker formats that cannot be downloaded",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();

      for (const scenario of [
        {
          messageId: 101,
          filePath: "stickers/animated.tgs",
          sticker: {
            file_id: "animated_sticker_id",
            file_unique_id: "animated_unique",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: true,
            is_video: false,
            emoji: "😎",
            set_name: "AnimatedPack",
          },
        },
        {
          messageId: 102,
          filePath: "stickers/video.webm",
          sticker: {
            file_id: "video_sticker_id",
            file_unique_id: "video_unique",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: false,
            is_video: true,
            emoji: "🎬",
            set_name: "VideoPack",
          },
        },
      ]) {
        replySpy.mockClear();
        runtimeError.mockClear();
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        await handler({
          message: {
            message_id: scenario.messageId,
            chat: { id: 1234, type: "private" },
            sticker: scenario.sticker,
            date: 1736380800,
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({ file_path: scenario.filePath }),
        });

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(replySpy).not.toHaveBeenCalled();
        expect(runtimeError).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
      }
    },
    STICKER_TEST_TIMEOUT_MS,
  );
});

describe("telegram text fragments", () => {
  afterEach(() => {
    vi.clearAllTimers();
  });

  const TEXT_FRAGMENT_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;
  const TEXT_FRAGMENT_FLUSH_MS = TELEGRAM_TEST_TIMINGS.textFragmentGapMs + 80;

  it(
    "buffers near-limit text and processes sequential parts as one message",
    async () => {
      const { handler, replySpy } = await createBotHandlerWithOptions({});
      vi.useFakeTimers();
      try {
        const part1 = "A".repeat(4050);
        const part2 = "B".repeat(50);

        await handler({
          message: {
            chat: { id: 42, type: "private" },
            message_id: 10,
            date: 1736380800,
            text: part1,
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        await handler({
          message: {
            chat: { id: 42, type: "private" },
            message_id: 11,
            date: 1736380801,
            text: part2,
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        expect(replySpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(TEXT_FRAGMENT_FLUSH_MS * 2);
        expect(replySpy).toHaveBeenCalledTimes(1);

        const payload = replySpy.mock.calls[0][0] as { RawBody?: string };
        expect(payload.RawBody).toContain(part1.slice(0, 32));
        expect(payload.RawBody).toContain(part2.slice(0, 32));
      } finally {
        vi.useRealTimers();
      }
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );
});
