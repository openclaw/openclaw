import { describe, expect, it, vi } from "vitest";
import { useFrozenTime, useRealTime } from "../../../test/helpers/extensions/frozen-time.js";

const harness = await import("./bot.create-telegram-bot.test-harness.js");
const {
  getLoadConfigMock,
  getOnHandler,
  replySpy,
  sendMessageSpy,
  telegramBotDepsForTest,
  telegramBotRuntimeForTest,
} = harness;

const { createTelegramBot: createTelegramBotBase, setTelegramBotRuntimeForTest } =
  await import("./bot.js");

setTelegramBotRuntimeForTest(
  telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
);

const createTelegramBot = (opts: Parameters<typeof createTelegramBotBase>[0]) =>
  createTelegramBotBase({
    ...opts,
    telegramDeps: telegramBotDepsForTest,
  });

const loadConfig = getLoadConfigMock();

const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
} as const;

function setOpenChannelPostConfig() {
  loadConfig.mockReturnValue({
    channels: {
      telegram: {
        groupPolicy: "open",
        groups: {
          "-100777111222": {
            enabled: true,
            requireMention: false,
          },
        },
      },
    },
  });
}

function getChannelPostHandler() {
  createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
  return getOnHandler("channel_post") as (ctx: Record<string, unknown>) => Promise<void>;
}

function resolveFlushTimer(setTimeoutSpy: ReturnType<typeof vi.spyOn>) {
  const flushTimerCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
    (call) => call[1] === TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
  );
  const flushTimer =
    flushTimerCallIndex >= 0
      ? (setTimeoutSpy.mock.calls[flushTimerCallIndex]?.[0] as (() => unknown) | undefined)
      : undefined;
  if (flushTimerCallIndex >= 0) {
    clearTimeout(
      setTimeoutSpy.mock.results[flushTimerCallIndex]?.value as ReturnType<typeof setTimeout>,
    );
  }
  return flushTimer;
}

describe("createTelegramBot channel_post media", () => {
  it("buffers channel_post media groups and processes them together", async () => {
    setOpenChannelPostConfig();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const handler = getChannelPostHandler();

      const first = handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 201,
          caption: "album caption",
          date: 1736380800,
          media_group_id: "channel-album-1",
          photo: [{ file_id: "p1" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/p1.jpg" }),
      });

      const second = handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 202,
          date: 1736380801,
          media_group_id: "channel-album-1",
          photo: [{ file_id: "p2" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/p2.jpg" }),
      });

      await Promise.all([first, second]);
      expect(replySpy).not.toHaveBeenCalled();

      const flushTimer = resolveFlushTimer(setTimeoutSpy);
      expect(flushTimer).toBeTypeOf("function");
      await flushTimer?.();

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0]?.[0] as { Body?: string };
      expect(payload.Body).toContain("album caption");
    } finally {
      setTimeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("coalesces channel_post near-limit text fragments into one message", async () => {
    setOpenChannelPostConfig();

    useFrozenTime("2026-02-20T00:00:00.000Z");
    try {
      const handler = getChannelPostHandler();

      const part1 = "A".repeat(4050);
      const part2 = "B".repeat(50);

      await handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 301,
          date: 1736380800,
          text: part1,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      await handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 302,
          date: 1736380801,
          text: part2,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      expect(replySpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(TELEGRAM_TEST_TIMINGS.textFragmentGapMs + 100);

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0]?.[0] as { RawBody?: string };
      expect(payload.RawBody).toContain(part1.slice(0, 32));
      expect(payload.RawBody).toContain(part2.slice(0, 32));
    } finally {
      useRealTime();
    }
  });

  it("drops oversized channel_post media instead of dispatching a placeholder message", async () => {
    setOpenChannelPostConfig();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );

    createTelegramBot({ token: "tok", mediaMaxMb: 0 });
    const handler = getOnHandler("channel_post") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      channelPost: {
        chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
        message_id: 401,
        date: 1736380800,
        photo: [{ file_id: "oversized" }],
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ file_path: "photos/oversized.jpg" }),
    });

    expect(replySpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("notifies users when media download fails for direct messages", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });
    sendMessageSpy.mockClear();
    replySpy.mockClear();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Promise.reject(new Error("MediaFetchError: Failed to fetch media")),
      );

    try {
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 1234, type: "private" },
          message_id: 411,
          date: 1736380800,
          photo: [{ file_id: "p1" }],
          from: { id: 55, is_bot: false, first_name: "u" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/p1.jpg" }),
      });

      expect(sendMessageSpy).toHaveBeenCalledWith(
        1234,
        "⚠️ Failed to download media. Please try again.",
        { reply_to_message_id: 411 },
      );
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("processes remaining media group photos when one photo download fails", async () => {
    replySpy.mockReset();
    setOpenChannelPostConfig();

    let fetchCallIndex = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCallIndex++;
      if (fetchCallIndex === 2) {
        throw new Error("MediaFetchError: Failed to fetch media");
      }
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const handler = getChannelPostHandler();

      const first = handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 401,
          caption: "partial album",
          date: 1736380800,
          media_group_id: "partial-album-1",
          photo: [{ file_id: "p1" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/p1.jpg" }),
      });

      const second = handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 402,
          date: 1736380801,
          media_group_id: "partial-album-1",
          photo: [{ file_id: "p2" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/p2.jpg" }),
      });

      await Promise.all([first, second]);
      expect(replySpy).not.toHaveBeenCalled();

      const flushTimer = resolveFlushTimer(setTimeoutSpy);
      expect(flushTimer).toBeTypeOf("function");
      await flushTimer?.();

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0]?.[0] as { Body?: string };
      expect(payload.Body).toContain("partial album");
    } finally {
      setTimeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("drops the media group when a non-recoverable media error occurs", async () => {
    replySpy.mockReset();
    setOpenChannelPostConfig();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const handler = getChannelPostHandler();

      const first = handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 501,
          caption: "fatal album",
          date: 1736380800,
          media_group_id: "fatal-album-1",
          photo: [{ file_id: "p1" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/p1.jpg" }),
      });

      const second = handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 502,
          date: 1736380801,
          media_group_id: "fatal-album-1",
          photo: [{ file_id: "p2" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      await Promise.all([first, second]);
      expect(replySpy).not.toHaveBeenCalled();

      const flushTimer = resolveFlushTimer(setTimeoutSpy);
      expect(flushTimer).toBeTypeOf("function");
      await flushTimer?.();

      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});
