import type { File as TelegramFile } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as keyedAsyncQueue from "openclaw/plugin-sdk/keyed-async-queue";
import type { SavedRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  holdTelegramMediaTimeouts,
  flushChannelPostMediaGroup,
  withTelegramGetFileRetryClock,
} from "./bot-media-timers.test-support.js";
import {
  createChannelPostContext,
  createTelegramPrivateMediaContext,
  queueChannelPostAlbum,
  telegramBotInfoForTest,
  telegramIngestGroupForTest,
  waitForTelegramMockCalls,
} from "./bot.create-telegram-bot.test-support.js";

const saveRemoteMedia = vi.fn();
const { triggerInternalHookMock } = vi.hoisted(() => ({
  triggerInternalHookMock: vi.fn<(event: unknown) => Promise<void>>(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/hook-runtime")>()),
  triggerInternalHook: triggerInternalHookMock,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  saveRemoteMedia: (...args: unknown[]) => saveRemoteMedia(...args),
}));

const harness = await import("./bot.create-telegram-bot.test-harness.js");
const { getLoadConfigMock, getOnHandler, replySpy, sendMessageSpy } = harness;
const { createTelegramBotCore: createTelegramBotBase } = await import("./bot-core.js");
const {
  getTelegramSpooledReplayDeferredParticipant,
  runWithTelegramSpooledReplayUpdate,
  runWithTelegramUpdateProcessingFrame,
} = await import("./bot-processing-outcome.js");
const { MediaFetchError } = await import("openclaw/plugin-sdk/media-runtime");

function createTelegramBot(opts: Partial<import("./bot.types.js").TelegramBotOptions> = {}) {
  return createTelegramBotBase({
    token: "tok",
    botInfo: telegramBotInfoForTest,
    telegramTransport: {
      fetch: globalThis.fetch,
      sourceFetch: globalThis.fetch,
      close: async () => {},
    },
    ...opts,
  });
}

const loadConfig = getLoadConfigMock();
type TelegramConfig = NonNullable<OpenClawConfig["channels"]>["telegram"];
const setTelegramConfig = (telegram: TelegramConfig, messages?: OpenClawConfig["messages"]) =>
  loadConfig.mockReturnValue({ channels: { telegram }, ...(messages ? { messages } : {}) });

const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
} as const;
const groupChat = { id: -100456, type: "supergroup", title: "Ops Chat" };

function setOpenChannelPostConfig() {
  setTelegramConfig(
    {
      groupPolicy: "open",
      groups: { "-100777111222": { enabled: true, requireMention: false } },
    },
    { inbound: { debounceMs: 0 } },
  );
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

async function withHeldAlbum(run: (flush: (timeoutMs?: number) => Promise<void>) => Promise<void>) {
  const timer = holdTelegramMediaTimeouts(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs);
  const queue = vi.spyOn(keyedAsyncQueue, "enqueueKeyedTask");
  try {
    await run((timeoutMs) => flushChannelPostMediaGroup(timer, queue, timeoutMs));
  } finally {
    timer.mockRestore();
    queue.mockRestore();
  }
}

const handleUpdate = (kind = "message") =>
  getOnHandler(kind) as (ctx: Record<string, unknown>) => Promise<void>;
const expectSilent = () => {
  expect(sendMessageSpy).not.toHaveBeenCalled();
  expect(replySpy).not.toHaveBeenCalled();
};

function expectUnavailableMediaPayload(
  kind: string,
  rawBody = "",
  notice = "[media unavailable: download failed]",
) {
  const payload = replySpy.mock.calls[0]![0];
  expect(payload).toMatchObject({
    Body: expect.stringContaining(notice),
    BodyForAgent: [rawBody, notice].filter(Boolean).join("\n\n"),
    media: [expect.objectContaining({ kind })],
    RawBody: rawBody,
  });
  expect(payload.media!.map(({ path, fileName }) => ({ path, fileName }))).toEqual([
    { path: undefined, fileName: undefined },
  ]);
}

function setTelegramIngestGroupConfig(
  telegram: TelegramConfig = {},
  customMentionPatterns = false,
) {
  setTelegramConfig(
    {
      groupPolicy: "open",
      groups: { "-100456": { requireMention: true, ingest: true } },
      ...telegram,
    },
    customMentionPatterns ? { groupChat: { mentionPatterns: ["\\bbert\\b"] } } : undefined,
  );
}

async function dispatchTelegramGroupPhoto(params: {
  messageId: number;
  topicId?: number;
  albumId?: string;
  caption?: string;
  extraMessage?: Record<string, unknown>;
  getFile?: (fileId: string) => Promise<TelegramFile>;
}) {
  const fileId = `photo-${params.messageId}`;
  const context = createTelegramPrivateMediaContext({ messageId: params.messageId, fileId });
  await handleUpdate()({
    ...context,
    message: {
      ...context.message,
      chat: { ...groupChat, is_forum: params.topicId !== undefined },
      ...(params.topicId ? { message_thread_id: params.topicId, is_topic_message: true } : {}),
      ...(params.albumId ? { media_group_id: params.albumId } : {}),
      ...(params.caption ? { caption: params.caption } : {}),
      ...params.extraMessage,
    },
    me: { id: 999, username: "openclaw_bot" },
    getFile: async () =>
      params.getFile?.(fileId) ?? mediaFile(fileId, `photos/${params.messageId}.jpg`),
  });
}

function expectTelegramIngestHook(messageIds: number[], expectedCalls = 1) {
  expect(triggerInternalHookMock).toHaveBeenCalledTimes(expectedCalls);
  if (!expectedCalls) {
    return;
  }
  const event = triggerInternalHookMock.mock.calls[0]?.[0] as {
    context: { media?: unknown[] };
  };
  expect(event).toMatchObject({
    type: "message",
    action: "received",
    context: { content: expect.stringMatching(/\S/u) },
  });
  expect(event.context.media).toEqual(
    messageIds.length
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
  setTelegramConfig({ dmPolicy: "open", allowFrom: ["*"], mediaMaxMb });
}

const commandEntities = (text: string, offset = 0) => [
  { type: "bot_command", offset, length: text.length - offset },
];

function expectTelegramDownloadWarning(messageId: number, warning?: string, chatId = 1234) {
  expect(sendMessageSpy).toHaveBeenCalledWith(
    chatId,
    warning ?? "⚠️ Failed to download media. Please try again.",
    expect.objectContaining({
      reply_parameters: expect.objectContaining({
        message_id: messageId,
        allow_sending_without_reply: true,
      }),
    }),
  );
}

function mediaFile(fileId: string, file_path: string): TelegramFile {
  return { file_id: fileId, file_unique_id: `unique-${fileId}`, file_path };
}

function expectOversizedDocument(messageId: number, limit: string) {
  expectTelegramDownloadWarning(messageId, `⚠️ File too large. Maximum size is ${limit}.`);
  expectUnavailableMediaPayload("document", "", `[media unavailable: file exceeds ${limit} limit]`);
}

describe("createTelegramBot channel_post media", () => {
  beforeEach(() => {
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
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["Bot API cap", 100021, 100, "20MB", true],
    ["fractional Bot API cap", 100022, 0.5, "512KB", true],
    ["non-binary-exact Bot API cap", 100023, 0.3, "307.20KB", true],
    ["permanent oversized media", 98077, undefined, "100MB", false],
    ["retryable shutdown abort", 98076, undefined, undefined, false],
  ] as const)(
    "reports and settles %s correctly (#98076)",
    async (_name, messageId, limit, reportedLimit, botApiCap) => {
      setOpenTelegramDirectConfig(limit);
      saveRemoteMedia.mockRejectedValue(
        reportedLimit
          ? new MediaFetchError("max_bytes", "payload exceeds maxBytes 10")
          : new MediaFetchError("fetch_failed", "aborted", {
              cause: Object.assign(new Error("aborted"), { name: "AbortError" }),
            }),
      );
      const warning = reportedLimit
        ? `⚠️ File too large. Maximum size is ${reportedLimit}.`
        : undefined;
      await createTelegramBot();
      const update = { update_id: messageId };
      const ctx = createTelegramPrivateMediaContext({
        messageId,
        fileId: `doc-${messageId}`,
        fileName: "document.pdf",
        update,
        ...(botApiCap
          ? {
              getFile: async () => {
                throw new Error("Bad Request: file is too big");
              },
            }
          : {}),
      });
      // Durable ingress reads the participant's settlement when the handler
      // created one; the frame result covers handlers that never reached it.
      const { value: participantResult, result: frameResult } =
        await runWithTelegramUpdateProcessingFrame(async () => {
          const replay = await runWithTelegramSpooledReplayUpdate(update, async () => {
            await handleUpdate()(ctx);
            return await getTelegramSpooledReplayDeferredParticipant()?.task;
          });
          return replay.value;
        });
      expect(participantResult ?? frameResult).toEqual(
        reportedLimit
          ? { kind: "completed" }
          : { kind: "failed-retryable", error: expect.any(MediaFetchError) },
      );
      const expectedWarnings = warning ? 1 : 0;
      expect(sendMessageSpy).toHaveBeenCalledTimes(expectedWarnings);
      expect(replySpy).toHaveBeenCalledTimes(expectedWarnings);
      expect(sendMessageSpy.mock.calls[0]?.[1]).toBe(warning);
      if (reportedLimit) {
        expectOversizedDocument(messageId, reportedLimit);
      }
      if (botApiCap) {
        expect(saveRemoteMedia).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ["topic enables group", false, true, true],
    ["topic disables group", true, false, false],
    ["unauthorized prefixed mention-optional command", true, undefined, false],
  ] as Array<[string, boolean, boolean | undefined, boolean]>)(
    "honors %s before skipping unmentioned group media (#92067)",
    async (_name, groupIngest, topicIngest, shouldIngest) => {
      const unauthorizedCommand = _name.startsWith("unauthorized");
      const command = "[Tue 2026-06-02 12:34] /reset";
      const topics = topicIngest === undefined ? undefined : { "42": { ingest: topicIngest } };
      const groups = {
        "-100456": {
          ...telegramIngestGroupForTest(groupIngest, topics),
          requireMention: !unauthorizedCommand,
        },
      };
      setTelegramIngestGroupConfig({
        groups,
        groupAllowFrom: unauthorizedCommand ? ["999"] : undefined,
      });
      const getFile = vi.fn(async (fileId: string) => mediaFile(fileId, "photos/ingested.jpg"));
      const fetchSpy = createImageFetchSpy();
      await createTelegramBot();
      await dispatchTelegramGroupPhoto({
        messageId: 92067,
        topicId: topicIngest === undefined ? undefined : 42,
        caption: unauthorizedCommand ? command : undefined,
        extraMessage: unauthorizedCommand
          ? { caption_entities: commandEntities(command, command.indexOf("/")) }
          : undefined,
        getFile,
      });
      const expectedCalls = Number(shouldIngest);
      expect(getFile).toHaveBeenCalledTimes(expectedCalls);
      expect(fetchSpy).toHaveBeenCalledTimes(expectedCalls);
      expectTelegramIngestHook([92067], expectedCalls);
      expectSilent();
    },
  );

  it("silently ingests unmentioned group media after a download error (#92067)", async () => {
    setTelegramIngestGroupConfig();
    await createTelegramBot();
    await withTelegramGetFileRetryClock("Network request for 'getFile' failed!", (getFile) =>
      dispatchTelegramGroupPhoto({ messageId: 92070, getFile }),
    );
    expectSilent();
    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expectTelegramIngestHook([]);
  });

  it.each([
    { name: "denied mention", messageIds: [92071, 92072], deniedMention: true },
    { name: "unauthorized", messageIds: [92079, 92080], deniedMention: false },
  ])(
    "applies group media album policy to $name (#92067)",
    async ({ messageIds, deniedMention }) => {
      const unauthorizedCommand = !deniedMention;
      setTelegramIngestGroupConfig(
        {
          groupAllowFrom: unauthorizedCommand ? ["999"] : undefined,
          ...(deniedMention ? { mentionPatterns: { mode: "deny" } } : {}),
        },
        deniedMention,
      );
      if (deniedMention) {
        saveRemoteMedia.mockRejectedValueOnce(
          new MediaFetchError("fetch_failed", "Failed to fetch media"),
        );
      }
      const fetchSpy = createImageFetchSpy();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const enqueueSpy = vi.spyOn(keyedAsyncQueue, "enqueueKeyedTask");
      const albumWork = () =>
        enqueueSpy.mock.results.flatMap((result, index) =>
          enqueueSpy.mock.calls[index]?.[0].key === "media:-100456:none:main" &&
          result.type === "return"
            ? [result.value]
            : [],
        );
      const getFile = vi.fn(async (fileId: string) =>
        mediaFile(fileId, "photos/ingested-album.jpg"),
      );
      try {
        await createTelegramBot({ testTimings: TELEGRAM_TEST_TIMINGS });
        // Admit both messages inside one window, including their awaited state writes.
        for (const [index, messageId] of messageIds.entries()) {
          const commandCaption = unauthorizedCommand && index === 1;
          const captions = unauthorizedCommand
            ? ["ordinary caption", "/reset@openclaw_bot"]
            : ["bert, see attachment", undefined];
          await dispatchTelegramGroupPhoto({
            messageId,
            albumId: "ingested-album",
            caption: captions[index],
            extraMessage: commandCaption
              ? { caption_entities: commandEntities("/reset@openclaw_bot") }
              : undefined,
            getFile,
          });
        }
        expect(getFile).not.toHaveBeenCalled();
        expect(albumWork()).toHaveLength(1);
        vi.advanceTimersByTime(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs);
        // Queue settlement includes real state-worker writes after the controlled debounce.
        await Promise.all(albumWork());
        expect(getFile).toHaveBeenCalledTimes(unauthorizedCommand ? 0 : 2);
        expect(fetchSpy).toHaveBeenCalledTimes(deniedMention ? 1 : 0);
        const ingestedIds = deniedMention ? messageIds.slice(1) : messageIds;
        expectTelegramIngestHook(ingestedIds, Number(!unauthorizedCommand));
        expectSilent();
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
    },
  );

  it.each([
    {
      name: "a targeted bot command",
      messageId: 81184,
      caption: "/inspect@openclaw_bot",
      extraMessage: { caption_entities: [{ type: "bot_command", offset: 0, length: 21 }] },
    },
    {
      name: "a reply to the bot",
      messageId: 81183,
      extraMessage: {
        reply_to_message: {
          message_id: 99,
          date: 1736380799,
          chat: groupChat,
          text: "previous bot reply",
          from: { id: 999, is_bot: true, first_name: "OpenClaw" },
        },
      },
    },
  ])("preserves visible media failures for $name (#92067)", async (testCase) => {
    setTelegramIngestGroupConfig({
      groups: { "*": { requireMention: true } },
    });
    saveRemoteMedia.mockRejectedValueOnce(new MediaFetchError("fetch_failed", "ECONNRESET"));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    await createTelegramBot();
    await dispatchTelegramGroupPhoto({
      messageId: testCase.messageId,
      ...("caption" in testCase ? { caption: testCase.caption } : {}),
      ...("extraMessage" in testCase ? { extraMessage: testCase.extraMessage } : {}),
    });
    await waitForTelegramMockCalls(sendMessageSpy, 1);
    expectTelegramDownloadWarning(testCase.messageId, undefined, -100456);
    expect(replySpy).toHaveBeenCalledOnce();
    expectUnavailableMediaPayload("image", "caption" in testCase ? testCase.caption : "");
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

    await withHeldAlbum(async (flush) => {
      await createTelegramBot({
        testTimings: TELEGRAM_TEST_TIMINGS,
        fetchAbortSignal: shutdown.signal,
      });
      const runs = await Promise.all(
        [98079, 98080].map((messageId, index) => {
          const update = { update_id: messageId };
          return runWithTelegramSpooledReplayUpdate(update, () =>
            handleUpdate("channel_post")({
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
      await flush(0);
      expect(await Promise.all(runs.map(({ deferredWork }) => deferredWork!.task))).toEqual([
        { kind: "failed-retryable", error: expect.any(MediaFetchError) },
        { kind: "failed-retryable", error: expect.any(MediaFetchError) },
      ]);
      expectSilent();
    });
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
    await withHeldAlbum(async (flush) => {
      await createTelegramBot({
        testTimings: TELEGRAM_TEST_TIMINGS,
        runtime: { error: runtimeError } as unknown as RuntimeEnv,
      });
      await queueChannelPostAlbum(handleUpdate("channel_post"), {
        caption: "fatal album",
        mediaGroupId: "fatal-album-1",
        firstMessageId: 501,
        secondMessageId: 502,
        secondGetFileResult: {},
      });
      expect(replySpy).not.toHaveBeenCalled();
      await flush(1_075);

      expect(runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("media group handler failed"),
      );
      expect(runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("Telegram getFile returned no file_path"),
      );
      expect(saveRemoteMedia).toHaveBeenCalledTimes(1);
      expect(replySpy).not.toHaveBeenCalled();
    });
  });
});
