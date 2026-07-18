// Telegram tests cover media-group per-item caption aggregation (#110690).
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const resolveMediaMock = vi.fn();

vi.mock("./bot/delivery.resolve-media.js", () => ({
  resolveMedia: (...args: unknown[]) => resolveMediaMock(...args),
}));

const { createTelegramInboundMediaGroupRuntime } =
  await import("./bot-handlers.inbound-media-group.runtime.js");

type AlbumMessage = ReturnType<typeof albumMessage>;

function albumMessage(params: { messageId: number; caption?: string }) {
  return {
    message_id: params.messageId,
    date: 1736380800 + params.messageId,
    chat: { id: 4242, type: "private" as const, first_name: "Alice" },
    from: { id: 42, is_bot: false as const, first_name: "Alice" },
    media_group_id: "album-1",
    photo: [{ file_id: `p${params.messageId}` }],
    ...(params.caption ? { caption: params.caption } : {}),
  };
}

function createRuntimeHarness() {
  resolveMediaMock.mockReset();
  resolveMediaMock.mockImplementation(async (params: { ctx: { fileId?: string } }) => ({
    path: `/tmp/${params.ctx.fileId ?? "media"}.jpg`,
    contentType: "image/jpeg",
  }));
  const processMessageWithReplyChain = vi.fn(async () => ({ kind: "completed" as const }));
  const messageRuntime = {
    mediaRuntimeWithAbort: {},
    promptContextBoundaryOptions: () => ({}),
    latestPromptContextMinTimestampMs: () => undefined,
    latestPromptContextAmbientWatermark: () => undefined,
    mergeDispatchDedupeClaims: (...claims: unknown[][]) => claims.flat(),
    releaseDispatchDedupeClaims: () => {},
    buildFailedProcessingResult: (error: unknown) => ({ kind: "failed" as const, error }),
    settleSpooledReplayParticipants: () => {},
    createSpooledReplayParticipantForBufferedWork: () => undefined,
    spooledReplayOptions: () => ({}),
    resolveTelegramSessionState: () => ({ sessionKey: "session", agentId: "agent" }),
    processMessageWithReplyChain,
  };
  const runtime = createTelegramInboundMediaGroupRuntime(
    {
      accountId: "default",
      bot: { api: { sendMessage: vi.fn(async () => ({})) } },
      opts: { testTimings: { mediaGroupFlushMs: 20 } },
      runtime: { log: () => {}, error: () => {} },
      mediaMaxBytes: 5 * 1024 * 1024,
      telegramCfg: {},
      logger: { info: () => {} },
      resolveGroupActivation: () => undefined,
      resolveGroupRequireMention: () => false,
    } as never,
    messageRuntime as never,
  );
  return { runtime, processMessageWithReplyChain };
}

function enqueueAlbum(
  runtime: ReturnType<typeof createRuntimeHarness>["runtime"],
  captions: readonly (string | undefined)[],
) {
  const messages: AlbumMessage[] = [];
  captions.forEach((caption, index) => {
    const msg = albumMessage({ messageId: 100 + index, caption });
    messages.push(msg);
    const handled = runtime.handleMediaGroup({
      ctx: { me: { username: "openclaw_bot" }, fileId: `p${msg.message_id}` },
      msg,
      chatId: 4242,
      isGroup: false,
      isForum: false,
      senderId: "42",
      authorizationCfg: {},
      effectiveGroupAllow: undefined,
      effectiveDmAllow: undefined,
      storeAllowFrom: [],
      dispatchDedupeClaims: [],
    } as never);
    expect(handled).toBe(true);
  });
  return messages;
}

async function waitForFlush() {
  await delay(120);
}

describe("processMediaGroup per-item captions (#110690)", () => {
  it("forwards every album message through the multi-message body path when captions span items", async () => {
    const { runtime, processMessageWithReplyChain } = createRuntimeHarness();
    enqueueAlbum(runtime, ["before shot", "during shot", "after shot"]);
    await waitForFlush();

    expect(processMessageWithReplyChain).toHaveBeenCalledTimes(1);
    const call = processMessageWithReplyChain.mock.calls[0]?.[0] as {
      msg: AlbumMessage;
      allMedia: unknown[];
      options?: { inboundDebounceMessages?: AlbumMessage[] };
    };
    expect(call.msg.message_id).toBe(100);
    expect(call.allMedia).toHaveLength(3);
    const forwarded = call.options?.inboundDebounceMessages;
    expect(forwarded).toBeDefined();
    expect(forwarded?.map((msg) => msg.message_id)).toEqual([100, 101, 102]);
    expect(forwarded?.map((msg) => msg.caption)).toEqual([
      "before shot",
      "during shot",
      "after shot",
    ]);
  });

  it("keeps caption order for albums with uncaptioned items between captions", async () => {
    const { runtime, processMessageWithReplyChain } = createRuntimeHarness();
    enqueueAlbum(runtime, ["first labeled", undefined, "third labeled"]);
    await waitForFlush();

    expect(processMessageWithReplyChain).toHaveBeenCalledTimes(1);
    const call = processMessageWithReplyChain.mock.calls[0]?.[0] as {
      options?: { inboundDebounceMessages?: AlbumMessage[] };
    };
    expect(call.options?.inboundDebounceMessages?.map((msg) => msg.caption ?? null)).toEqual([
      "first labeled",
      null,
      "third labeled",
    ]);
  });

  it("keeps the single-caption album on the existing primary-message path", async () => {
    const { runtime, processMessageWithReplyChain } = createRuntimeHarness();
    enqueueAlbum(runtime, ["solo caption", undefined, undefined]);
    await waitForFlush();

    expect(processMessageWithReplyChain).toHaveBeenCalledTimes(1);
    const call = processMessageWithReplyChain.mock.calls[0]?.[0] as {
      msg: AlbumMessage;
      allMedia: unknown[];
      options?: { inboundDebounceMessages?: AlbumMessage[] };
    };
    expect(call.msg.caption).toBe("solo caption");
    expect(call.allMedia).toHaveLength(3);
    expect(call.options?.inboundDebounceMessages).toBeUndefined();
  });

  it("keeps a tail-only caption on the existing primary-message path", async () => {
    const { runtime, processMessageWithReplyChain } = createRuntimeHarness();
    enqueueAlbum(runtime, [undefined, undefined, "tail caption"]);
    await waitForFlush();

    expect(processMessageWithReplyChain).toHaveBeenCalledTimes(1);
    const call = processMessageWithReplyChain.mock.calls[0]?.[0] as {
      msg: AlbumMessage;
      options?: { inboundDebounceMessages?: AlbumMessage[] };
    };
    expect(call.msg.caption).toBe("tail caption");
    expect(call.options?.inboundDebounceMessages).toBeUndefined();
  });
});

describe("message context renders forwarded album captions (#110690)", () => {
  it("keeps every caption and positional placeholders in the aggregated body", async () => {
    const chat = { id: 4242, type: "private" as const, first_name: "Alice" };
    const sender = { id: 42, first_name: "Alice", is_bot: false };
    const first = {
      message_id: 100,
      date: 1_700_000_000,
      chat,
      from: sender,
      photo: [{ file_id: "p100" }],
      caption: "before shot",
    };
    const context = await buildTelegramMessageContextForTest({
      message: first,
      options: {
        inboundDebounceMessages: [
          first,
          {
            message_id: 101,
            date: 1_700_000_001,
            chat,
            from: sender,
            photo: [{ file_id: "p101" }],
          },
          {
            message_id: 102,
            date: 1_700_000_002,
            chat,
            from: sender,
            photo: [{ file_id: "p102" }],
            caption: "after shot",
          },
        ],
      },
    });

    const body = String(context?.ctxPayload?.Body ?? "");
    expect(body).toContain("before shot");
    expect(body).toContain("after shot");
    expect(body.indexOf("before shot")).toBeLessThan(body.indexOf("after shot"));
    const middle = body.slice(body.indexOf("before shot"), body.indexOf("after shot"));
    expect(middle).toContain("<media:image>");
  });
});
