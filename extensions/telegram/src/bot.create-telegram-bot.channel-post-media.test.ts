import type { File as TelegramFile } from "grammy/types";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { SavedRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  holdTelegramMediaTimeouts,
  flushChannelPostMediaGroup,
} from "./bot-media-timers.test-support.js";
import {
  createChannelPostContext,
  createTelegramPrivateMediaContext,
  queueChannelPostAlbum,
  telegramBotInfoForTest,
  telegramIngestGroupForTest,
  waitForTelegramMockCalls,
  type TelegramIngestGroupForTest,
  type TelegramMentionPolicyForTest,
} from "./bot.create-telegram-bot.test-support.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";

const saveRemoteMedia = vi.fn();
const { triggerInternalHookMock } = vi.hoisted(() => ({
  triggerInternalHookMock: vi.fn<(event: unknown) => Promise<void>>(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/hook-runtime")>(
    "openclaw/plugin-sdk/hook-runtime",
  );
  return {
    ...actual,
    triggerInternalHook: triggerInternalHookMock,
  };
});

vi.mock("./telegram-media.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./telegram-media.runtime.js")>();
  return {
    ...actual,
    saveRemoteMedia: (...args: unknown[]) => saveRemoteMedia(...args),
  };
});

vi.mock("./sticker-cache.js", () => ({
  cacheSticker: () => {},
  getCachedSticker: () => null,
  getCacheStats: () => ({ count: 0 }),
  searchStickers: () => [],
  getAllCachedStickers: () => [],
  describeStickerImage: async () => null,
}));

const harness = await import("./bot.create-telegram-bot.test-harness.js");
const { getLoadConfigMock, getOnHandler, replySpy, sendMessageSpy, telegramBotDepsForTest } =
  harness;
const { createTelegramBotCore: createTelegramBotBase } = await import("./bot-core.js");
const {
  getTelegramSpooledReplayDeferredParticipant,
  runWithTelegramSpooledReplayUpdate,
  runWithTelegramUpdateProcessingFrame,
} = await import("./bot-processing-outcome.js");
const { MediaFetchError } = await import("./telegram-media.runtime.js");

let createTelegramBot: (
  opts: import("./bot.types.js").TelegramBotOptions,
) => ReturnType<typeof import("./bot-core.js").createTelegramBotCore>;

const loadConfig = getLoadConfigMock();

const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
} as const;

async function withTelegramSpooledReplayUpdate<T>(
  update: object,
  fn: () => Promise<T>,
): Promise<T> {
  return (await runWithTelegramSpooledReplayUpdate(update, fn)).value;
}

function setOpenChannelPostConfig() {
  loadConfig.mockReturnValue({
    messages: { inbound: { debounceMs: 0 } },
    channels: {
      telegram: {
        groupPolicy: "open",
        groups: { "-100777111222": { enabled: true, requireMention: false } },
      },
    },
  });
}

function createImageFetchSpy() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
  );
}

function replyPayload(): Record<string, unknown> {
  const call = replySpy.mock.calls.at(0);
  if (!call || !call[0] || typeof call[0] !== "object") {
    throw new Error("Expected reply payload");
  }
  return call[0] as Record<string, unknown>;
}

function expectUnavailableMediaPayload(
  kind: string,
  rawBody = "",
  notice = "[media unavailable: download failed]",
) {
  const payload = replyPayload();
  expect(payload).toMatchObject({
    Body: expect.stringContaining(notice),
    BodyForAgent: [rawBody, notice].filter(Boolean).join("\n\n"),
    media: [expect.objectContaining({ kind })],
    RawBody: rawBody,
  });
  const media = payload.media as Array<{ path?: string; fileName?: string }>;
  expect(media).toHaveLength(1);
  expect(media[0]?.path).toBeUndefined();
  expect(media[0]?.fileName).toBeUndefined();
}

function setTelegramIngestGroupConfig(
  params: {
    groups?: Record<string, TelegramIngestGroupForTest>;
    groupAllowFrom?: string[];
    providerPolicy?: TelegramMentionPolicyForTest;
    customMentionPatterns?: boolean;
  } = {},
) {
  loadConfig.mockReturnValue({
    ...(params.customMentionPatterns
      ? { messages: { groupChat: { mentionPatterns: ["\\bbert\\b"] } } }
      : {}),
    channels: {
      telegram: {
        groupPolicy: "open",
        ...(params.groupAllowFrom ? { groupAllowFrom: params.groupAllowFrom } : {}),
        ...(params.providerPolicy ? { mentionPatterns: params.providerPolicy } : {}),
        groups: params.groups ?? { "-100456": { requireMention: true, ingest: true } },
      },
    },
  });
}

async function dispatchTelegramGroupPhoto(params: {
  messageId: number;
  topicId?: number;
  albumId?: string;
  caption?: string;
  extraMessage?: Record<string, unknown>;
  getFile?: (fileId: string) => Promise<TelegramFile>;
}) {
  const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
  const fileId = `photo-${params.messageId}`;
  await handler({
    message: {
      chat: {
        id: -100456,
        type: "supergroup",
        title: "Ops Chat",
        is_forum: params.topicId !== undefined,
      },
      message_id: params.messageId,
      date: 1736380800,
      ...(params.topicId ? { message_thread_id: params.topicId, is_topic_message: true } : {}),
      ...(params.albumId ? { media_group_id: params.albumId } : {}),
      ...(params.caption ? { caption: params.caption } : {}),
      ...params.extraMessage,
      photo: [
        {
          file_id: fileId,
          file_unique_id: `unique-${fileId}`,
          width: 1,
          height: 1,
        },
      ],
      from: { id: 55, is_bot: false, first_name: "u" },
    },
    me: { id: 999, username: "openclaw_bot" },
    getFile: async () =>
      params.getFile
        ? await params.getFile(fileId)
        : {
            file_id: fileId,
            file_unique_id: `unique-${fileId}`,
            file_path: `photos/${params.messageId}.jpg`,
          },
  });
}

function expectTelegramIngestHook(
  messageIds: number[],
  params: { content?: string; expectedCalls?: number } = {},
) {
  const expectedCalls = params.expectedCalls ?? 1;
  const event = triggerInternalHookMock.mock.calls[0]?.[0] as
    | { type: string; action: string; context: { content: string; media?: unknown[] } }
    | undefined;
  expect(triggerInternalHookMock).toHaveBeenCalledTimes(expectedCalls);
  expect(event?.type).toEqual(expectedCalls ? "message" : undefined);
  expect(event?.action).toEqual(expectedCalls ? "received" : undefined);
  expect(event?.context.content).toEqual(
    expectedCalls ? (params.content ?? expect.stringMatching(/\S/u)) : undefined,
  );
  expect(event?.context.media).toEqual(
    expectedCalls && messageIds.length
      ? messageIds.map((messageId) =>
          expect.objectContaining({
            path: "/tmp/telegram-media.bin",
            contentType: "image/png",
            kind: "image",
            messageId: String(messageId),
          }),
        )
      : undefined,
  );
}

function setOpenTelegramDirectConfig(mediaMaxMb?: number) {
  loadConfig.mockReturnValue({
    channels: {
      telegram: {
        dmPolicy: "open",
        allowFrom: ["*"],
        ...(mediaMaxMb === undefined ? {} : { mediaMaxMb }),
      },
    },
  });
}

function expectTelegramDownloadWarning(messageId: number, warning?: string) {
  expect(sendMessageSpy).toHaveBeenCalledWith(
    1234,
    warning ?? "⚠️ Failed to download media. Please try again.",
    expect.objectContaining({
      reply_parameters: expect.objectContaining({
        message_id: messageId,
        allow_sending_without_reply: true,
      }),
    }),
  );
}

function rejectFirstTelegramAlbumDownloadWhen(partial: boolean) {
  if (partial) {
    saveRemoteMedia.mockRejectedValueOnce(
      new MediaFetchError("fetch_failed", "Failed to fetch media"),
    );
  }
}

describe("createTelegramBot channel_post media", () => {
  beforeAll(() => {
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        botInfo: telegramBotInfoForTest,
        telegramTransport: {
          fetch: globalThis.fetch,
          sourceFetch: globalThis.fetch,
          close: async () => {},
        },
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
  });

  beforeEach(() => {
    setTelegramPluginStateRuntimeForTests();
    triggerInternalHookMock.mockClear();
    saveRemoteMedia.mockReset();
    saveRemoteMedia.mockImplementation(
      async (params: { fetchImpl: typeof fetch; maxBytes: number; url: string }) => {
        const response = await params.fetchImpl(params.url);
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (buffer.length > params.maxBytes) {
          throw new MediaFetchError("max_bytes", `payload exceeds maxBytes ${params.maxBytes}`);
        }
        return {
          id: "telegram-media.bin",
          path: "/tmp/telegram-media.bin",
          size: buffer.byteLength,
          contentType: response.headers.get("content-type") ?? undefined,
        } satisfies SavedRemoteMedia;
      },
    );
  });

  it("warns and dispatches a type-only fact when Telegram getFile fails (#100000)", async () => {
    setOpenTelegramDirectConfig();
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    await handler(
      createTelegramPrivateMediaContext({
        messageId: 100000,
        fileId: "doc-100000",
        fileName: "report.pdf",
        getFile: async () => {
          throw new Error("Network request for 'getFile' failed!");
        },
      }),
    );
    await waitForTelegramMockCalls(sendMessageSpy, 1);
    expectTelegramDownloadWarning(100000);
    expect(replySpy).toHaveBeenCalledOnce();
    expectUnavailableMediaPayload("document");
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });

  it.each([
    { mediaMaxMb: 100, expectedLimitMb: 20 },
    { mediaMaxMb: 10, expectedLimitMb: 10 },
  ])(
    "reports the effective $expectedLimitMb MB limit for Telegram Bot API failures (#100000)",
    async ({ mediaMaxMb, expectedLimitMb }) => {
      setOpenTelegramDirectConfig(mediaMaxMb);
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      const messageId = 100001 + expectedLimitMb;
      await handler(
        createTelegramPrivateMediaContext({
          messageId,
          fileId: "doc-100001",
          fileName: "large.bin",
          getFile: async () => {
            throw new Error("Bad Request: file is too big");
          },
        }),
      );
      await waitForTelegramMockCalls(sendMessageSpy, 1);
      expectTelegramDownloadWarning(
        messageId,
        `⚠️ File too large. Maximum size is ${expectedLimitMb}MB.`,
      );
      expect(replySpy).toHaveBeenCalledOnce();
      expectUnavailableMediaPayload(
        "document",
        "",
        `[media unavailable: file exceeds ${expectedLimitMb}MB limit]`,
      );
      expect(saveRemoteMedia).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "retryable shutdown abort",
      messageId: 98076,
      error: new MediaFetchError("fetch_failed", "aborted", {
        cause: Object.assign(new Error("aborted"), { name: "AbortError" }),
      }),
      result: { kind: "failed-retryable", error: expect.any(MediaFetchError) },
      warning: undefined,
    },
    {
      name: "permanent oversized media",
      messageId: 98077,
      error: new MediaFetchError("max_bytes", "Failed to fetch media: payload exceeds maxBytes 10"),
      result: { kind: "completed" },
      warning: "⚠️ File too large. Maximum size is 100MB.",
      notice: "[media unavailable: file exceeds 100MB limit]",
    },
    {
      name: "permanent SSRF rejection",
      messageId: 98078,
      error: new MediaFetchError("fetch_failed", "blocked by SSRF guard: private address"),
      result: { kind: "completed" },
      warning: "⚠️ Failed to download media. Please try again.",
    },
  ])("preserves durable replay handling for $name (#98076)", async (testCase) => {
    setOpenTelegramDirectConfig();
    saveRemoteMedia.mockRejectedValue(testCase.error);
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const update = { update_id: testCase.messageId };
    const ctx = createTelegramPrivateMediaContext({
      messageId: testCase.messageId,
      fileId: `doc-${testCase.messageId}`,
      fileName: "document.pdf",
      update,
    });
    // Durable ingress reads the participant's settlement when the handler
    // created one; the frame result covers handlers that never reached it.
    const { value: participantResult, result: frameResult } =
      await runWithTelegramUpdateProcessingFrame(() =>
        withTelegramSpooledReplayUpdate(update, async () => {
          await handler(ctx);
          return await getTelegramSpooledReplayDeferredParticipant()?.task;
        }),
      );
    expect(participantResult ?? frameResult).toEqual(testCase.result);
    const expectedWarnings = testCase.warning ? 1 : 0;
    expect(sendMessageSpy).toHaveBeenCalledTimes(expectedWarnings);
    expect(replySpy).toHaveBeenCalledTimes(expectedWarnings);
    expect(sendMessageSpy.mock.calls[0]?.[1]).toBe(testCase.warning);
    if (testCase.warning) {
      expectTelegramDownloadWarning(testCase.messageId, testCase.warning);
      expectUnavailableMediaPayload("document", "", testCase.notice);
    }
  });

  it.each([
    ["default disabled", undefined, undefined, undefined, false],
    ["enabled group", true, undefined, undefined, true],
    ["wildcard inherited", undefined, true, undefined, true],
    ["group disables wildcard", false, true, undefined, false],
    ["topic enables group", false, undefined, true, true],
    ["topic disables group", true, undefined, false, false],
    ["unauthorized unmentioned command", true, undefined, undefined, false],
    ["unauthorized mentioned command", true, undefined, undefined, false],
    ["unauthorized mention-optional command", true, undefined, undefined, false],
    ["unauthorized prefixed mention-optional command", true, undefined, undefined, false],
  ] as Array<[string, boolean | undefined, boolean | undefined, boolean | undefined, boolean]>)(
    "honors %s before skipping unmentioned group media (#92067)",
    async (_name, groupIngest, wildcardIngest, topicIngest, shouldIngest) => {
      const unauthorizedCommand = _name.startsWith("unauthorized");
      const command = `${_name.includes("prefixed") ? "[Tue 2026-06-02 12:34] " : ""}${
        _name === "unauthorized mentioned command" ? "/reset@openclaw_bot" : "/reset"
      }`;
      const commandOffset = command.indexOf("/");
      const topics = topicIngest === undefined ? undefined : { "42": { ingest: topicIngest } };
      const groups = {
        ...(wildcardIngest === undefined
          ? {}
          : { "*": telegramIngestGroupForTest(wildcardIngest) }),
        "-100456": {
          ...telegramIngestGroupForTest(groupIngest, topics),
          requireMention: !_name.includes("mention-optional"),
        },
      };
      setTelegramIngestGroupConfig({
        groups,
        groupAllowFrom: unauthorizedCommand ? ["999"] : undefined,
      });
      const getFile = vi.fn(async (fileId: string) => ({
        file_id: fileId,
        file_unique_id: `unique-${fileId}`,
        file_path: "photos/ingested.jpg",
      }));
      const fetchSpy = createImageFetchSpy();
      try {
        createTelegramBot({ token: "tok" });
        await dispatchTelegramGroupPhoto({
          messageId: 92067,
          topicId: topicIngest === undefined ? undefined : 42,
          caption: unauthorizedCommand ? command : undefined,
          extraMessage: unauthorizedCommand
            ? {
                caption_entities: [
                  {
                    type: "bot_command",
                    offset: commandOffset,
                    length: command.length - commandOffset,
                  },
                ],
              }
            : undefined,
          getFile,
        });
        const expectedCalls = Number(shouldIngest);
        expect(getFile).toHaveBeenCalledTimes(expectedCalls);
        expect(fetchSpy).toHaveBeenCalledTimes(expectedCalls);
        expectTelegramIngestHook([92067], { expectedCalls });
        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(replySpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );

  it.each([
    { failure: "a download error", error: "Network request for 'getFile' failed!" },
    { failure: "an oversized file", error: "Bad Request: file is too big" },
  ])("silently ingests unmentioned group media after $failure (#92067)", async ({ error }) => {
    setTelegramIngestGroupConfig();
    createTelegramBot({ token: "tok" });
    await dispatchTelegramGroupPhoto({
      messageId: 92070,
      getFile: async () => {
        throw new Error(error);
      },
    });
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expectTelegramIngestHook([]);
  });

  it.each([
    { name: "all", messageIds: [92068, 92069], partial: false, deniedMention: false },
    { name: "partial", messageIds: [92071, 92072], partial: true, deniedMention: false },
    { name: "denied mention", messageIds: [92071, 92072], partial: true, deniedMention: true },
    { name: "unauthorized", messageIds: [92079, 92080], partial: false, deniedMention: false },
  ])("applies group media album policy to $name (#92067)", async (testCase) => {
    const unauthorizedCommand = testCase.name === "unauthorized";
    setTelegramIngestGroupConfig({
      customMentionPatterns: testCase.deniedMention,
      groupAllowFrom: unauthorizedCommand ? ["999"] : undefined,
      ...(testCase.deniedMention ? { providerPolicy: { mode: "deny" } } : {}),
    });
    rejectFirstTelegramAlbumDownloadWhen(testCase.partial);
    const fetchSpy = createImageFetchSpy();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const enqueueSpy = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue");
    const albumWork = () =>
      enqueueSpy.mock.results.flatMap((result, index) =>
        enqueueSpy.mock.calls[index]?.[0] === "media:-100456:none:main:ingested-album" &&
        result.type === "return"
          ? [result.value]
          : [],
      );
    const getFile = vi.fn(async (fileId: string) => ({
      file_id: fileId,
      file_unique_id: `unique-${fileId}`,
      file_path: "photos/ingested-album.jpg",
    }));
    try {
      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      // Admit both messages inside one window, including their awaited state writes.
      for (const messageId of testCase.messageIds) {
        const commandCaption = unauthorizedCommand && messageId === testCase.messageIds[1];
        await dispatchTelegramGroupPhoto({
          messageId,
          albumId: "ingested-album",
          caption: commandCaption
            ? "/reset@openclaw_bot"
            : unauthorizedCommand
              ? "ordinary caption"
              : testCase.deniedMention && messageId === testCase.messageIds[0]
                ? "bert, see attachment"
                : undefined,
          extraMessage: commandCaption
            ? { caption_entities: [{ type: "bot_command", offset: 0, length: 19 }] }
            : undefined,
          getFile,
        });
      }
      expect(getFile).not.toHaveBeenCalled();
      vi.advanceTimersByTime(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs);
      expect(albumWork()).toHaveLength(1);
      // Queue settlement includes real state-worker writes after the controlled debounce.
      await Promise.all(albumWork());
      expect(getFile).toHaveBeenCalledTimes(unauthorizedCommand ? 0 : 2);
      expect(fetchSpy).toHaveBeenCalledTimes(unauthorizedCommand ? 0 : testCase.partial ? 1 : 2);
      const ingestedIds = testCase.partial ? testCase.messageIds.slice(1) : testCase.messageIds;
      expectTelegramIngestHook(ingestedIds, { expectedCalls: Number(!unauthorizedCommand) });
      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      try {
        vi.advanceTimersByTime(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs);
        // Admitted work still owns these mocks if an assertion fails before settlement.
        await Promise.all(albumWork());
      } finally {
        enqueueSpy.mockRestore();
        vi.useRealTimers();
        fetchSpy.mockRestore();
      }
    }
  });

  it.each([
    {
      name: "a native mention",
      messageId: 81182,
      caption: "@openclaw_bot check this",
      ingest: false,
    },
    {
      name: "a native mention with ingestion",
      messageId: 81186,
      caption: "@openclaw_bot check this",
      ingest: true,
    },
    {
      name: "a native mention with denied patterns",
      messageId: 81185,
      caption: "@openclaw_bot check this",
      ingest: true,
      denyPatterns: true,
    },
    {
      name: "a targeted bot command",
      messageId: 81184,
      caption: "/inspect@openclaw_bot",
      extraMessage: { caption_entities: [{ type: "bot_command", offset: 0, length: 21 }] },
      ingest: false,
    },
    {
      name: "a reply to the bot",
      messageId: 81183,
      extraMessage: {
        reply_to_message: {
          message_id: 99,
          date: 1736380799,
          chat: { id: -100456, type: "supergroup", title: "Ops Chat" },
          text: "previous bot reply",
          from: { id: 999, is_bot: true, first_name: "OpenClaw" },
        },
      },
      ingest: false,
    },
  ])("preserves visible media failures for $name (#92067)", async (testCase) => {
    setTelegramIngestGroupConfig({
      groups: { "*": { requireMention: true, ...(testCase.ingest ? { ingest: true } : {}) } },
      ...("denyPatterns" in testCase ? { providerPolicy: { mode: "deny" } } : {}),
    });
    saveRemoteMedia.mockRejectedValueOnce(new MediaFetchError("fetch_failed", "ECONNRESET"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    try {
      createTelegramBot({ token: "tok" });
      await dispatchTelegramGroupPhoto({
        messageId: testCase.messageId,
        ...("caption" in testCase ? { caption: testCase.caption } : {}),
        ...("extraMessage" in testCase ? { extraMessage: testCase.extraMessage } : {}),
      });
      await waitForTelegramMockCalls(sendMessageSpy, 1);
      expect(sendMessageSpy).toHaveBeenCalledWith(
        -100456,
        "⚠️ Failed to download media. Please try again.",
        expect.objectContaining({
          reply_parameters: expect.objectContaining({
            message_id: testCase.messageId,
            allow_sending_without_reply: true,
          }),
        }),
      );
      expect(replySpy).toHaveBeenCalledOnce();
      expectUnavailableMediaPayload("image", "caption" in testCase ? testCase.caption : "");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([
    { failure: "shutdown aborts a download", shutdownAbort: true },
    { failure: "Telegram temporarily throttles a download", shutdownAbort: false },
  ])("durably retries every spooled album update when $failure", async ({ shutdownAbort }) => {
    setOpenChannelPostConfig();
    const shutdown = new AbortController();
    saveRemoteMedia.mockImplementationOnce(async () => {
      if (shutdownAbort) {
        shutdown.abort();
        const cause = Object.assign(new Error("aborted"), { name: "AbortError" });
        throw new MediaFetchError("fetch_failed", "aborted", { cause });
      }
      throw new MediaFetchError("http_error", "rate limited", { status: 429 });
    });

    const setTimeoutSpy = holdTelegramMediaTimeouts(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs);
    try {
      createTelegramBot({
        token: "tok",
        testTimings: TELEGRAM_TEST_TIMINGS,
        fetchAbortSignal: shutdown.signal,
      });
      const handler = getOnHandler("channel_post") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      const runs = await Promise.all(
        [98079, 98080].map((messageId, index) => {
          const update = { update_id: messageId };
          return runWithTelegramSpooledReplayUpdate(update, () =>
            handler({
              ...createChannelPostContext({
                messageId,
                ...(index === 0 ? { caption: "shutdown album" } : {}),
                date: 1736380800 + index,
                mediaGroupId: "shutdown-album-1",
                photoFileId: `p${index + 1}`,
              }),
              update,
            }),
          );
        }),
      );
      expect(runs.map(({ deferredWork }) => Boolean(deferredWork))).toEqual([true, true]);
      // Replay participant processing already uses the overall test timeout.
      await flushChannelPostMediaGroup(setTimeoutSpy, 0);
      expect(await Promise.all(runs.map(({ deferredWork }) => deferredWork!.task))).toEqual([
        { kind: "failed-retryable", error: expect.any(MediaFetchError) },
        { kind: "failed-retryable", error: expect.any(MediaFetchError) },
      ]);
      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("drops the media group when a non-recoverable media error occurs", async () => {
    replySpy.mockReset();
    setOpenChannelPostConfig();
    saveRemoteMedia.mockResolvedValueOnce({
      id: "fatal-album-first.jpg",
      path: "/tmp/fatal-album-first.jpg",
      size: 4,
      contentType: "image/jpeg",
    } satisfies SavedRemoteMedia);

    const runtimeError = vi.fn();
    const setTimeoutSpy = holdTelegramMediaTimeouts(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs);
    try {
      createTelegramBot({
        token: "tok",
        testTimings: TELEGRAM_TEST_TIMINGS,
        runtime: { error: runtimeError } as unknown as RuntimeEnv,
      });
      const handler = getOnHandler("channel_post") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      await queueChannelPostAlbum(handler, {
        caption: "fatal album",
        mediaGroupId: "fatal-album-1",
        firstMessageId: 501,
        secondMessageId: 502,
        secondGetFileResult: {},
      });
      expect(replySpy).not.toHaveBeenCalled();
      await flushChannelPostMediaGroup(setTimeoutSpy, 1_075);

      expect(runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("media group handler failed"),
      );
      expect(runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("Telegram getFile returned no file_path"),
      );
      expect(saveRemoteMedia).toHaveBeenCalledTimes(1);
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
