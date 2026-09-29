// Telegram tests cover reply media source identity from ingress to the provider image payload.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clearTimeout as cancelTimeout, setTimeout as scheduleTimeout } from "node:timers";
import { detectAndLoadAgentHarnessPromptImages } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  readRemoteMediaBufferSpy,
  setNextSavedMediaPath,
  telegramMediaHarnessGetFileSpy,
} from "./bot.media.e2e.test-harness.js";
import {
  TELEGRAM_TEST_TIMINGS,
  createBotHandlerWithOptions,
  createTelegramPhotoForTest,
  mockTelegramPngDownload,
} from "./bot.media.test-utils.js";

// A decodable 1x1 PNG, so the prompt image loader treats both staged copies as real images.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
// A second decodable 1x1 PNG with a different pixel, for a genuinely distinct source.
const OTHER_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYPj/HwADAgH/OSkZvgAAAABJRU5ErkJggg==",
  "base64",
);

function stageInboundPng(id: string, bytes: Buffer = PNG_BYTES): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("media harness state dir is not set");
  }
  const inboundDir = path.join(stateDir, "media", "inbound");
  mkdirSync(inboundDir, { recursive: true });
  const filePath = path.join(inboundDir, id);
  writeFileSync(filePath, bytes);
  return filePath;
}

async function loadProviderImages(ctx: MsgContext) {
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? "";
  // The same SDK loader agent harnesses use to build provider image input.
  const { images } = await detectAndLoadAgentHarnessPromptImages({
    prompt: "",
    workspaceDir: stateDir,
    model: { input: ["text", "image"] },
    media: ctx.media,
    localRoots: [stateDir],
  });
  const unique = new Set(
    images.map((image) => createHash("sha256").update(image.data).digest("hex")),
  );
  return { payloads: images.length, unique: unique.size };
}

type ScheduledTimer = {
  callback: () => unknown;
  handle: ReturnType<typeof setTimeout>;
};

// Hold media-group deadlines so the test releases a fully assembled album; every other
// timer keeps native scheduling. Kept local because the shared hold helper lives in a
// different test-support module on newer main.
function holdMediaGroupDeadlines() {
  return vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    const handle = scheduleTimeout(callback, delay, ...args);
    if (delay === TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs) {
      cancelTimeout(handle);
    }
    return handle;
  });
}

// Flush only the media-group deadline timers, mirroring the album e2e suite.
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

async function flushMediaGroupTimers(
  setTimeoutSpy: ReturnType<typeof vi.spyOn>,
  clearTimeoutSpy: ReturnType<typeof vi.spyOn>,
  expectedCount: number,
): Promise<void> {
  const timers = resolveActiveScheduledTimersForDelay(
    setTimeoutSpy,
    clearTimeoutSpy,
    TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
  );
  expect(timers).toHaveLength(expectedCount);
  for (const timer of timers) {
    clearTimeout(timer.handle);
    await timer.callback();
  }
}

const originalMessage = {
  message_id: 1101,
  chat: { id: 1234, type: "private" as const },
  from: { id: 777, is_bot: false, first_name: "Ada" },
  photo: [{ file_id: "original-file", file_unique_id: "shared-telegram-source" }],
  date: 1736380800,
};
const me = { id: 999, username: "openclaw_bot" };

describe("telegram reply media source identity", () => {
  // Parallel vitest shards can make this suite slower than the standalone run.
  const TEST_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 90_000;

  it(
    "sends one provider image when the current and replied messages stage one source at different paths",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();
      const originalPath = stageInboundPng("original-source.png");
      const currentPath = stageInboundPng("current-source.png");

      try {
        setNextSavedMediaPath({ path: originalPath, id: "original-source.png" });
        await handler({
          message: originalMessage,
          me,
          getFile: async () => ({ file_path: "photos/original.png" }),
        });

        replySpy.mockClear();
        setNextSavedMediaPath({ path: currentPath, id: "current-source.png" });
        await handler({
          message: {
            message_id: 1102,
            chat: originalMessage.chat,
            from: originalMessage.from,
            photo: [{ file_id: "current-file", file_unique_id: "shared-telegram-source" }],
            reply_to_message: originalMessage,
            date: 1736380801,
          },
          me,
          getFile: async () => ({ file_path: "photos/current.png" }),
        });

        expect(runtimeError).not.toHaveBeenCalled();
        expect(replySpy).toHaveBeenCalledTimes(1);
        const ctx = replySpy.mock.calls[0]?.[0] as MsgContext | undefined;
        if (!ctx) {
          throw new Error("expected one reply call");
        }
        expect(await loadProviderImages(ctx)).toEqual({ payloads: 1, unique: 1 });
        expect(ctx).toMatchObject({ MediaPaths: [currentPath] });
      } finally {
        fetchSpy.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the unavailable-media notice and the replied copy when the current download fails",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();
      const originalPath = stageInboundPng("original-source.png");

      try {
        setNextSavedMediaPath({ path: originalPath, id: "original-source.png" });
        await handler({
          message: originalMessage,
          me,
          getFile: async () => ({ file_path: "photos/original.png" }),
        });

        replySpy.mockClear();
        readRemoteMediaBufferSpy.mockRejectedValueOnce(new Error("permanent download failure"));
        await handler({
          message: {
            message_id: 1102,
            chat: originalMessage.chat,
            from: originalMessage.from,
            caption: "same picture",
            photo: [{ file_id: "current-file", file_unique_id: "shared-telegram-source" }],
            reply_to_message: originalMessage,
            date: 1736380801,
          },
          me,
          getFile: async () => ({ file_path: "photos/current.png" }),
        });

        expect(replySpy).toHaveBeenCalledTimes(1);
        const ctx = replySpy.mock.calls[0]?.[0] as MsgContext | undefined;
        if (!ctx) {
          throw new Error("expected one reply call");
        }
        expect(ctx.BodyForAgent).toContain("[media unavailable: download failed]");
        // The failed current attachment claims no source, so the replied copy is the one image.
        expect(await loadProviderImages(ctx)).toEqual({ payloads: 1, unique: 1 });
      } finally {
        fetchSpy.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "drops a reply ancestor whose source is already an attachment of the replying album",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();
      const originalPath = stageInboundPng("original-source.png");
      const albumSamePath = stageInboundPng("album-same-source.png");
      const albumOtherPath = stageInboundPng("album-other-source.png", OTHER_PNG_BYTES);

      try {
        setNextSavedMediaPath({ path: originalPath, id: "original-source.png" });
        await handler({
          message: originalMessage,
          me,
          getFile: async () => ({ file_path: "photos/original.png" }),
        });
        expect(replySpy).toHaveBeenCalledTimes(1);

        // One album replies to the original photo and re-sends it next to a new photo.
        // Only album ingress knows the album copy's file_unique_id, so without that
        // handoff the replied-to original hydrates as a third provider image.
        replySpy.mockClear();
        const setTimeoutSpy = holdMediaGroupDeadlines();
        const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
        try {
          const albumBase = {
            chat: originalMessage.chat,
            from: originalMessage.from,
            media_group_id: "album-source-group",
            reply_to_message: originalMessage,
            date: 1736380801,
          };
          setNextSavedMediaPath({ path: albumSamePath, id: "album-same-source.png" });
          setNextSavedMediaPath({ path: albumOtherPath, id: "album-other-source.png" });
          await handler({
            message: {
              ...albumBase,
              message_id: 1102,
              caption: "same picture, plus a new one",
              photo: [
                {
                  ...createTelegramPhotoForTest("album-same-file"),
                  file_unique_id: "shared-telegram-source",
                },
              ],
            },
            me,
            getFile: async () => ({ file_path: "photos/album-same.png" }),
          });
          await handler({
            message: {
              ...albumBase,
              message_id: 1103,
              photo: [createTelegramPhotoForTest("album-other-file")],
            },
            me,
            getFile: async () => ({ file_path: "photos/album-other.png" }),
          });

          // The album buffer holds both photos until its flush deadline.
          expect(replySpy).not.toHaveBeenCalled();
          await flushMediaGroupTimers(setTimeoutSpy, clearTimeoutSpy, 1);
          await vi.waitFor(() => expect(replySpy).toHaveBeenCalledTimes(1));
        } finally {
          setTimeoutSpy.mockRestore();
          clearTimeoutSpy.mockRestore();
        }

        expect(runtimeError).not.toHaveBeenCalled();
        const ctx = replySpy.mock.calls[0]?.[0] as MsgContext | undefined;
        if (!ctx) {
          throw new Error("expected one reply call");
        }
        expect(ctx).toMatchObject({ MediaPaths: [albumSamePath, albumOtherPath] });
        expect(await loadProviderImages(ctx)).toEqual({ payloads: 2, unique: 2 });
      } finally {
        fetchSpy.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "dedupes a same-source external reply against the current media",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();
      const currentPath = stageInboundPng("shared-source.png");

      try {
        setNextSavedMediaPath({ path: currentPath, id: "shared-source.png" });
        await handler({
          message: {
            message_id: 1501,
            chat: { id: 1234, type: "private" as const },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            photo: [{ file_id: "current-file", file_unique_id: "shared-telegram-source" }],
            date: 1736380800,
            external_reply: {
              message_id: 1500,
              chat: { id: -10022, type: "supergroup" as const, title: "Source" },
              from: { id: 22, is_bot: false, first_name: "Ada" },
              origin: {
                type: "user" as const,
                sender_user: { id: 22, is_bot: false, first_name: "Ada" },
                date: 1736380700,
              },
              photo: [{ file_id: "external-file", file_unique_id: "shared-telegram-source" }],
            },
          },
          me,
          getFile: async () => ({ file_path: "photos/shared.png" }),
        });

        expect(replySpy).toHaveBeenCalledTimes(1);
        // The external copy shares the current media's file_unique_id, so it is
        // dropped instead of hydrated under a second path.
        expect(telegramMediaHarnessGetFileSpy).not.toHaveBeenCalled();
        const ctx = replySpy.mock.calls[0]?.[0] as MsgContext | undefined;
        if (!ctx) {
          throw new Error("expected one reply call");
        }
        expect(await loadProviderImages(ctx)).toEqual({ payloads: 1, unique: 1 });
      } finally {
        fetchSpy.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
