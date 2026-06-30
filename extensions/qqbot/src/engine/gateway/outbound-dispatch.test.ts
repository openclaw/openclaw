// Qqbot tests cover outbound dispatch plugin behavior.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { InboundContext } from "./inbound-context.js";
import { dispatchOutbound } from "./outbound-dispatch.js";
import type { GatewayAccount, GatewayPluginRuntime } from "./types.js";

const sendVoiceMessageMock = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => ({ id: "voice-1", timestamp: "2026-04-25T00:00:00.000Z" })),
);
const sendMediaMock = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => ({ id: "media-1", timestamp: "2026-04-25T00:00:00.000Z" })),
);
const sendTextMock = vi.hoisted(() =>
  vi.fn(async (..._params: unknown[]) => ({
    id: "text-1",
    timestamp: "2026-04-25T00:00:00.000Z",
  })),
);
const audioFileToSilkBase64Mock = vi.hoisted(() => vi.fn(async () => "silk-base64"));

vi.mock("../messaging/sender.js", () => ({
  accountToCreds: (account: GatewayAccount) => ({
    appId: account.appId,
    clientSecret: account.clientSecret,
  }),
  buildDeliveryTarget: (target: { type: string; senderId: string; groupOpenid?: string }) => ({
    type: target.type === "group" ? "group" : target.type === "c2c" ? "c2c" : target.type,
    id: target.type === "group" ? target.groupOpenid : target.senderId,
  }),
  initApiConfig: vi.fn(),
  sendFileMessage: vi.fn(),
  sendImage: vi.fn(),
  sendText: sendTextMock,
  sendVideoMessage: vi.fn(),
  sendVoiceMessage: sendVoiceMessageMock,
  sendMedia: sendMediaMock,
  withTokenRetry: async (_creds: unknown, fn: () => Promise<unknown>) => await fn(),
}));

vi.mock("../utils/audio.js", () => ({
  audioFileToSilkBase64: audioFileToSilkBase64Mock,
}));

const account: GatewayAccount = {
  accountId: "qq-main",
  appId: "app",
  clientSecret: "secret",
  markdownSupport: false,
  config: {},
};

function makeInbound(overrides: Partial<InboundContext> = {}): InboundContext {
  return {
    event: {
      type: "c2c",
      senderId: "user-openid",
      messageId: "msg-1",
      content: "voice",
      timestamp: "2026-04-25T00:00:00.000Z",
    },
    route: { sessionKey: "qqbot:c2c:user-openid", accountId: "qq-main" },
    isGroupChat: false,
    peerId: "user-openid",
    qualifiedTarget: "qqbot:c2c:user-openid",
    fromAddress: "qqbot:c2c:user-openid",
    agentBody: "voice",
    body: "voice",
    localMediaPaths: [],
    localMediaTypes: [],
    remoteMediaUrls: [],
    uniqueVoicePaths: [],
    uniqueVoiceUrls: [],
    uniqueVoiceAsrReferTexts: [],
    voiceMediaTypes: [],
    hasAsrReferFallback: false,
    voiceTranscriptSources: [],
    commandAuthorized: false,
    blocked: false,
    skipped: false,
    typing: { keepAlive: null },
    ...overrides,
  };
}

function makeInboundRuntime(): GatewayPluginRuntime["channel"]["inbound"] {
  return {
    run: vi.fn(async (rawParams: unknown) => {
      const params = rawParams as {
        raw: unknown;
        adapter: {
          ingest: (raw: unknown) => unknown;
          resolveTurn: (...args: unknown[]) => unknown;
        };
      };
      const input = await params.adapter.ingest(params.raw);
      const turn = (await params.adapter.resolveTurn(
        input,
        {
          canStartAgentTurn: true,
          kind: "message",
        },
        {},
      )) as { runDispatch: () => Promise<unknown> };
      return { dispatchResult: await turn.runDispatch() };
    }),
  };
}

function makeRuntime(params: {
  onFinalize?: (ctx: Record<string, unknown>) => void;
  isControlCommandMessage?: (text?: string, cfg?: unknown) => boolean;
  skipFreshSettledDelivery?: boolean;
  onDispatch?: (dispatcherOptions: {
    deliver: (
      payload: { text?: string; mediaUrl?: string; mediaUrls?: string[]; audioAsVoice?: boolean },
      info: { kind: string },
    ) => Promise<void>;
    onSkip?: (
      payload: { text?: string; mediaUrl?: string; mediaUrls?: string[]; audioAsVoice?: boolean },
      info: { kind: string; reason: "empty" | "silent" | "heartbeat" },
    ) => void;
    onSettled?: () => unknown;
    onFreshSettledDelivery?: () => unknown;
  }) => Promise<void>;
  onDeliver?: (
    deliver: (
      payload: { text?: string; mediaUrl?: string; mediaUrls?: string[]; audioAsVoice?: boolean },
      info: { kind: string },
    ) => Promise<void>,
  ) => Promise<void>;
}): GatewayPluginRuntime {
  return {
    channel: {
      activity: { record: vi.fn() },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          sessionKey: "qqbot:c2c:user-openid",
          accountId: "qq-main",
        })),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(async (rawParams: unknown) => {
          const dispatcherOptions = (
            rawParams as {
              dispatcherOptions: {
                deliver: (
                  payload: {
                    text?: string;
                    mediaUrl?: string;
                    mediaUrls?: string[];
                    audioAsVoice?: boolean;
                  },
                  info: { kind: string },
                ) => Promise<void>;
                onSkip?: (
                  payload: {
                    text?: string;
                    mediaUrl?: string;
                    mediaUrls?: string[];
                    audioAsVoice?: boolean;
                  },
                  info: { kind: string; reason: "empty" | "silent" | "heartbeat" },
                ) => void;
                onSettled?: () => unknown;
                onFreshSettledDelivery?: () => unknown;
              };
            }
          ).dispatcherOptions;
          if (params.onDispatch) {
            await params.onDispatch(dispatcherOptions);
          } else {
            await params.onDeliver?.(dispatcherOptions.deliver);
          }
          await dispatcherOptions.onSettled?.();
          if (!params.skipFreshSettledDelivery) {
            await dispatcherOptions.onFreshSettledDelivery?.();
          }
        }),
        finalizeInboundContext: vi.fn((rawCtx: Record<string, unknown>) => {
          params.onFinalize?.(rawCtx);
          return rawCtx;
        }),
        formatInboundEnvelope: vi.fn(() => "voice"),
        resolveEffectiveMessagesConfig: vi.fn(() => ({})),
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/openclaw/qqbot-sessions.json"),
        recordInboundSession: vi.fn(async () => undefined),
      },
      inbound: makeInboundRuntime(),
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
      commands: {
        isControlCommandMessage: params.isControlCommandMessage ?? (() => false),
      },
    },
    tts: {
      textToSpeech: vi.fn(async () => ({
        success: true,
        audioPath: "/tmp/openclaw-qqbot/tts.wav",
        provider: "test-tts",
        outputFormat: "wav",
      })),
    },
  };
}

describe("dispatchOutbound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps waiting past 300s when a slow provider timeout is configured", async () => {
    vi.useFakeTimers();
    try {
      const runtime = makeRuntime({
        onDeliver: async (deliver) => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 301_000);
          });
          await deliver({ text: "late answer" }, { kind: "block" });
        },
      });
      let settled = false;

      const dispatchPromise = dispatchOutbound(makeInbound(), {
        runtime,
        cfg: {
          models: { providers: { ollama: { timeoutSeconds: 1800 } } },
        },
        account,
      }).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(300_000);

      expect(settled).toBe(false);
      expect(sendTextMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await dispatchPromise;

      expect(sendTextMock).toHaveBeenCalledWith(
        expect.anything(),
        "late answer",
        expect.anything(),
        expect.anything(),
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("marks voice-only inbound as audio without adding voice paths to MediaPaths", async () => {
    let finalized: Record<string, unknown> | undefined;
    const runtime = makeRuntime({ onFinalize: (ctx) => (finalized = ctx) });

    await dispatchOutbound(
      makeInbound({
        uniqueVoicePaths: ["/tmp/qqbot/voice.wav"],
        voiceMediaTypes: ["audio/wav"],
      }),
      { runtime, cfg: {}, account },
    );

    expect(finalized?.MediaType).toBe("audio/wav");
    expect(finalized?.MediaTypes).toEqual(["audio/wav"]);
    expect(finalized?.QQVoiceAttachmentPaths).toEqual(["/tmp/qqbot/voice.wav"]);
    expect(finalized).not.toHaveProperty("MediaPath");
    expect(finalized).not.toHaveProperty("MediaPaths");
  });

  it("synthesizes plain audioAsVoice text as a QQ voice reply", async () => {
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ text: "read this aloud", audioAsVoice: true }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), { runtime, cfg: {}, account });

    expect(runtime.tts.textToSpeech).toHaveBeenCalledWith({
      text: "read this aloud",
      cfg: {},
      channel: "qqbot",
      accountId: "qq-main",
    });
    expect(audioFileToSilkBase64Mock).toHaveBeenCalledWith("/tmp/openclaw-qqbot/tts.wav");
    const sentMedia = sendMediaMock.mock.calls.at(0)?.[0] as
      | { kind?: string; source?: unknown; msgId?: string; ttsText?: string }
      | undefined;
    expect(sentMedia?.kind).toBe("voice");
    expect(sentMedia?.source).toEqual({ base64: "silk-base64" });
    expect(sentMedia?.msgId).toBe("msg-1");
    expect(sentMedia?.ttsText).toBe("read this aloud");
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it("delivers text-only tool progress immediately in partial streaming mode", async () => {
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ text: "Working: checking logs" }, { kind: "tool" });
        await deliver({ text: "final answer" }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, config: { streaming: { mode: "partial" } } },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([
      "Working: checking logs",
      "final answer",
    ]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("strips echoed inbound metadata from direct block replies", async () => {
    const echoedMetadataReply = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{"chat_id":"qqbot:c2c:user-openid","inbound_event_kind":"user_request"}',
      "```",
      "",
      "Sender (untrusted metadata):",
      "```json",
      '{"label":"Alice","id":"user-openid"}',
      "```",
      "",
      "final answer",
    ].join("\n");
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ text: echoedMetadataReply }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), { runtime, cfg: {}, account });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual(["final answer"]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("keeps metadata-prefixed silent direct block replies suppressed", async () => {
    const echoedSilentReply = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{"chat_id":"qqbot:c2c:user-openid","inbound_event_kind":"user_request"}',
      "```",
      "",
      "Sender (untrusted metadata):",
      "```json",
      '{"label":"Alice","id":"user-openid"}',
      "```",
      "",
      "NO_REPLY",
    ].join("\n");
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ text: echoedSilentReply }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), { runtime, cfg: {}, account });

    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("delivers text-only tool progress immediately in recommended C2C streaming mode", async () => {
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ text: "Working: checking logs" }, { kind: "tool" });
        await deliver({ text: "final answer" }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, config: { streaming: true } },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([
      "Working: checking logs",
      "final answer",
    ]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("delivers text-only tool progress for legacy C2C stream API accounts", async () => {
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ text: "Working: checking logs" }, { kind: "tool" });
        await deliver({ text: "final answer" }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: {
        ...account,
        config: { streaming: { mode: "off", c2cStreamApi: true } },
      },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([
      "Working: checking logs",
      "final answer",
    ]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("keeps immediate tool progress media-like text inert with markdown support enabled", async () => {
    const progress = "progress ![x](http://internal.example/progress.png)";
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ text: progress }, { kind: "tool" });
        await deliver({ text: "final answer" }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, markdownSupport: true, config: { streaming: { mode: "partial" } } },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([progress, "final answer"]);
    expect(sendTextMock.mock.calls[0]?.[3]).toMatchObject({ forcePlainText: true });
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("keeps text-only tool progress buffered when streaming is off", async () => {
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ text: "Working: checking logs" }, { kind: "tool" });
        await deliver({ text: "final answer" }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, config: { streaming: false } },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual(["final answer"]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("flushes buffered tool text when non-streaming final block is silent", async () => {
    const runtime = makeRuntime({
      onDispatch: async ({ deliver, onSkip }) => {
        await deliver({ text: "first visible tool message" }, { kind: "tool" });
        await deliver({ text: "second visible tool message" }, { kind: "tool" });
        onSkip?.({ text: "NO_REPLY" }, { kind: "block", reason: "silent" });
      },
    });

    await dispatchOutbound(
      makeInbound({
        event: {
          type: "group",
          senderId: "member-openid",
          messageId: "msg-group-tool-final-silent",
          content: "<@BOT> do it",
          timestamp: "2026-04-25T00:00:00.000Z",
          groupOpenid: "group-openid",
        },
        route: { sessionKey: "qqbot:group:group-openid", accountId: "qq-main" },
        isGroupChat: true,
        peerId: "group-openid",
        qualifiedTarget: "qqbot:group:group-openid",
        fromAddress: "qqbot:group:group-openid",
        agentBody: "do it",
        body: "[member-openid] do it (@you)",
      }),
      { runtime, cfg: {}, account: { ...account, config: { streaming: false } } },
    );

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([
      "first visible tool message",
      "second visible tool message",
    ]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("keeps buffered tool text suppressed when a visible block precedes a silent final skip", async () => {
    const runtime = makeRuntime({
      onDispatch: async ({ deliver, onSkip }) => {
        await deliver({ text: "Working: checking logs" }, { kind: "tool" });
        onSkip?.({ text: "NO_REPLY" }, { kind: "final", reason: "silent" });
        await deliver({ text: "final answer" }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, config: { streaming: false } },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual(["final answer"]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("does not re-send tool fallback after timeout when non-streaming final block is silent", async () => {
    vi.useFakeTimers();
    const runtime = makeRuntime({
      onDispatch: async ({ deliver, onSkip }) => {
        await deliver({ text: "visible tool message" }, { kind: "tool" });
        await vi.advanceTimersByTimeAsync(60_000);
        onSkip?.({ text: "NO_REPLY" }, { kind: "block", reason: "silent" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, config: { streaming: false } },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual(["visible tool message"]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("waits for fresh settled delivery after a skipped silent block", async () => {
    vi.useFakeTimers();
    const runtime = makeRuntime({
      onDispatch: async ({ deliver, onSkip }) => {
        await deliver({ text: "visible tool message" }, { kind: "tool" });
        onSkip?.({ text: "NO_REPLY" }, { kind: "block", reason: "silent" });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sendTextMock).not.toHaveBeenCalled();
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, config: { streaming: false } },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual(["visible tool message"]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("does not send stale tool fallback when fresh settled delivery is suppressed", async () => {
    vi.useFakeTimers();
    const runtime = makeRuntime({
      skipFreshSettledDelivery: true,
      onDispatch: async ({ deliver, onSkip }) => {
        await deliver({ text: "stale visible tool message" }, { kind: "tool" });
        onSkip?.({ text: "NO_REPLY" }, { kind: "block", reason: "silent" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, config: { streaming: false } },
    });

    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendMediaMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds tool media flushes without racing the fallback timer", async () => {
    vi.useFakeTimers();
    sendMediaMock.mockImplementationOnce(() => new Promise(() => {}));
    sendMediaMock.mockImplementationOnce(() => new Promise(() => {}));
    const firstMediaUrl = "https://example.com/progress-1.png";
    const secondMediaUrl = "https://example.com/progress-2.png";
    const runtime = makeRuntime({
      onDispatch: async ({ deliver, onSkip }) => {
        await deliver({ mediaUrl: firstMediaUrl }, { kind: "tool" });
        await deliver({ mediaUrl: secondMediaUrl }, { kind: "tool" });
        await deliver({ text: "visible tool message" }, { kind: "tool" });
        onSkip?.({ text: "NO_REPLY" }, { kind: "block", reason: "silent" });
      },
    });

    const dispatchPromise = dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, config: { streaming: false } },
    });

    await vi.advanceTimersByTimeAsync(90_000);
    await dispatchPromise;

    expect(sendMediaMock).toHaveBeenCalledTimes(2);
    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual(["visible tool message"]);
  });

  it("clears the media timeout after a successful silent-final flush", async () => {
    vi.useFakeTimers();
    const mediaUrl = "https://example.com/progress.png";
    const runtime = makeRuntime({
      onDispatch: async ({ deliver, onSkip }) => {
        await deliver({ mediaUrl }, { kind: "tool" });
        onSkip?.({ text: "NO_REPLY" }, { kind: "block", reason: "silent" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, config: { streaming: false } },
    });

    expect(sendMediaMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { name: "empty text", payload: {} },
    { name: "silent token", payload: { text: "NO_REPLY" } },
  ])("delivers media-only non-streaming final block replies with $name", async ({ payload }) => {
    const mediaUrl = "https://example.com/final.png";
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ ...payload, mediaUrl }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, config: { streaming: false } },
    });

    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendMediaMock).toHaveBeenCalledWith({
      creds: { appId: "app", clientSecret: "secret" },
      kind: "image",
      msgId: "msg-1",
      source: { url: mediaUrl },
      target: { id: "user-openid", type: "c2c" },
    });
  });

  it("renews pending tool-media fallback when partial progress is delivered", async () => {
    vi.useFakeTimers();
    const mediaUrl = "https://example.com/progress.png";
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await deliver({ mediaUrl }, { kind: "tool" });
        await vi.advanceTimersByTimeAsync(59_000);
        await deliver({ text: "Working: checking logs" }, { kind: "tool" });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(sendMediaMock).not.toHaveBeenCalled();
        await deliver({ text: "final answer" }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, config: { streaming: { mode: "partial" } } },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([
      "Working: checking logs",
      "final answer",
    ]);
    expect(sendMediaMock).toHaveBeenCalledTimes(1);
  });

  it("marks recognized C2C framework slash commands as text commands", async () => {
    let finalized: Record<string, unknown> | undefined;
    const runtime = makeRuntime({
      isControlCommandMessage: (text) => text === "/models",
      onFinalize: (ctx) => (finalized = ctx),
    });

    await dispatchOutbound(
      makeInbound({
        event: {
          type: "c2c",
          senderId: "user-openid",
          messageId: "msg-models",
          content: "/models",
          timestamp: "2026-04-25T00:00:00.000Z",
        },
        agentBody: "/models",
        body: "/models",
        commandAuthorized: true,
      }),
      { runtime, cfg: { commands: { text: true } }, account },
    );

    expect(finalized?.CommandBody).toBe("/models");
    expect(finalized?.CommandAuthorized).toBe(true);
    expect(finalized?.CommandSource).toBe("text");
    expect(finalized?.Provider).toBe("qqbot");
    expect(finalized?.Surface).toBe("qqbot");
    expect(finalized?.ChatType).toBe("direct");
  });

  it("keeps markdown table chunks self-contained across block deliveries", async () => {
    const runtime = makeRuntime({
      onDispatch: async ({ deliver }) => {
        await deliver(
          {
            text: ["| Id | Value |", "|---:|---|", "| 1 | alpha |"].join("\n"),
          },
          { kind: "block" },
        );
        await deliver({ text: ["| 2 | beta |", "| 3 | gamma |"].join("\n") }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account,
    });

    expect(sendTextMock).toHaveBeenCalledTimes(2);
    expect(sendTextMock.mock.calls[0]?.[1]).toBe(
      ["| Id | Value |", "|---:|---|", "| 1 | alpha |"].join("\n"),
    );
    expect(sendTextMock.mock.calls[1]?.[1]).toBe(
      ["| Id | Value |", "|---:|---|", "| 2 | beta |", "| 3 | gamma |"].join("\n"),
    );
  });

  it("waits for a table separator when a block ends after the header", async () => {
    const runtime = makeRuntime({
      onDispatch: async ({ deliver }) => {
        await deliver({ text: "| Id | Value |" }, { kind: "block" });
        await deliver({ text: ["|---:|---|", "| 1 | alpha |"].join("\n") }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account,
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([
      ["| Id | Value |", "|---:|---|", "| 1 | alpha |"].join("\n"),
    ]);
  });

  it("flushes unfinished markdown table row fragments as plain text fields", async () => {
    const runtime = makeRuntime({
      onDispatch: async ({ deliver }) => {
        await deliver(
          {
            text: ["| Id | Function | Status |", "|---:|---|---|", "| 1 | auth | ok |"].join("\n"),
          },
          { kind: "block" },
        );
        await deliver({ text: "| 10 | analyzeerror_patterns | 无需重试" }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account,
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([
      ["| Id | Function | Status |", "|---:|---|---|", "| 1 | auth | ok |"].join("\n"),
      ["Id: 10", "Function: analyzeerror_patterns", "Status: 无需重试"].join("\n"),
    ]);
  });

  it("holds short table rows until a following block completes the columns", async () => {
    const runtime = makeRuntime({
      onDispatch: async ({ deliver }) => {
        await deliver(
          {
            text: [
              "| Id | Time | Owner | Note |",
              "|---:|---|---|---|",
              "| 16 | 40ms | He | ok |",
              "| 17 | 100ms |",
            ].join("\n"),
          },
          { kind: "block" },
        );
        await deliver({ text: "Lin | daily cap |" }, { kind: "block" });
      },
    });

    await dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account,
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([
      ["| Id | Time | Owner | Note |", "|---:|---|---|---|", "| 16 | 40ms | He | ok |"].join("\n"),
      [
        "| Id | Time | Owner | Note |",
        "|---:|---|---|---|",
        "| 17 | 100ms | Lin | daily cap |",
      ].join("\n"),
    ]);
  });
});
