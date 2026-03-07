import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const getFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const createReplyDispatcherWithTypingMock = vi.hoisted(() => vi.fn());
const addTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "om_msg" })));
const removeTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => {}));
const streamingInstances = vi.hoisted(() => [] as any[]);

vi.mock("./accounts.js", () => ({ resolveFeishuAccount: resolveFeishuAccountMock }));
vi.mock("./runtime.js", () => ({ getFeishuRuntime: getFeishuRuntimeMock }));
vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
  sendMarkdownCardFeishu: sendMarkdownCardFeishuMock,
}));
vi.mock("./media.js", () => ({ sendMediaFeishu: sendMediaFeishuMock }));
vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));
vi.mock("./targets.js", () => ({ resolveReceiveIdType: resolveReceiveIdTypeMock }));
vi.mock("./typing.js", () => ({
  addTypingIndicator: addTypingIndicatorMock,
  removeTypingIndicator: removeTypingIndicatorMock,
}));
vi.mock("./streaming-card.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./streaming-card.js")>();
  return {
    mergeStreamingText: actual.mergeStreamingText,
    FeishuStreamingSession: class {
      active = false;
      start = vi.fn(async () => {
        this.active = true;
      });
      update = vi.fn(async () => {});
      close = vi.fn(async () => {
        this.active = false;
      });
      isActive = vi.fn(() => this.active);

      constructor() {
        streamingInstances.push(this);
      }
    },
  };
});

import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";

describe("createFeishuReplyDispatcher streaming behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamingInstances.length = 0;
    sendMediaFeishuMock.mockResolvedValue(undefined);

    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
      },
    });

    resolveReceiveIdTypeMock.mockReturnValue("chat_id");
    createFeishuClientMock.mockReturnValue({});

    createReplyDispatcherWithTypingMock.mockImplementation((opts) => ({
      dispatcher: {},
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _opts: opts,
    }));

    getFeishuRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          resolveChunkMode: vi.fn(() => "line"),
          resolveMarkdownTableMode: vi.fn(() => "preserve"),
          convertMarkdownTables: vi.fn((text) => text),
          chunkTextWithMode: vi.fn((text) => [text]),
        },
        reply: {
          createReplyDispatcherWithTyping: createReplyDispatcherWithTypingMock,
          resolveHumanDelayConfig: vi.fn(() => undefined),
        },
      },
    });
  });

  it("skips typing indicator when account typingIndicator is disabled", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
        typingIndicator: false,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("skips typing indicator for stale replayed messages", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Date.now() - 3 * 60_000,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("treats second-based timestamps as stale for typing suppression", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Math.floor((Date.now() - 3 * 60_000) / 1000),
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("keeps typing indicator for fresh messages", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Date.now() - 30_000,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).toHaveBeenCalledTimes(1);
    expect(addTypingIndicatorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "om_parent",
      }),
    );
  });

  it("keeps auto mode plain text on non-streaming send path", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "plain text" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("suppresses internal block payload delivery", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "internal reasoning chunk" }, { kind: "block" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
  });

  it("sets disableBlockStreaming in replyOptions to prevent silent reply drops", async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    expect(result.replyOptions).toHaveProperty("disableBlockStreaming", true);
  });

  it("uses streaming session for auto mode markdown payloads", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      rootId: "om_root_topic",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].start).toHaveBeenCalledWith("oc_chat", "chat_id", {
      replyToMessageId: undefined,
      replyInThread: undefined,
      rootId: "om_root_topic",
    });
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("closes streaming with block text when final reply is missing", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```md\npartial answer\n```" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("```md\npartial answer\n```");
  });

  it("delivers distinct final payloads after streaming close", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```md\nFirst part of full reply\n```" }, { kind: "final" });
    await options.deliver(
      { text: "```md\nFirst part of full reply + second part\n```" },
      { kind: "final" },
    );

    expect(streamingInstances).toHaveLength(2);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith(
      "```md\nFirst part of full reply\n```",
    );
    expect(streamingInstances[1].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[1].close).toHaveBeenCalledWith(
      "```md\nFirst part of full reply + second part\n```",
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("skips exact duplicate final text after streaming close", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```md\nsame reply\n```" }, { kind: "final" });
    await options.deliver({ text: "```md\nsame reply\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("```md\nsame reply\n```");
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });
  it("suppresses duplicate final text while still sending media", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: false,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "plain final" }, { kind: "final" });
    await options.deliver(
      { text: "plain final", mediaUrl: "https://example.com/a.png" },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "plain final",
      }),
    );
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
      }),
    );
  });

  it("keeps distinct non-streaming final payloads", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: false,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "notice header" }, { kind: "final" });
    await options.deliver({ text: "actual answer body" }, { kind: "final" });

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendMessageFeishuMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "notice header" }),
    );
    expect(sendMessageFeishuMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "actual answer body" }),
    );
  });

  it("merges block payloads as snapshots to avoid duplication (e.g. ACP coalescer, tool calls)", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();
    // Block-only: sequential deltas "hello" + " world" append to "hello world"
    await options.deliver({ text: "hello" }, { kind: "block" });
    await options.deliver({ text: " world" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("hello world");
  });

  it("appends first block when merge would drop it (partial ABCDEF + block ABC)", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();
    await result.replyOptions.onPartialReply?.({ text: "ABCDEF" });
    await options.deliver({ text: "ABC" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    const closedText = streamingInstances[0].close.mock.calls[0]?.[0] as string;
    expect(closedText).toBe("ABCDEFABC");
  });

  it("does not duplicate when block payloads are cumulative (tool-call scenario, #38938)", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();
    // Simulate cumulative block payloads from ACP coalescer (e.g. after tool call)
    await options.deliver({ text: "Looks like" }, { kind: "block" });
    await options.deliver({ text: "Looks like XX's Actions" }, { kind: "block" });
    await options.deliver(
      { text: "Looks like XX's Actions are all fine, last 10 runs succeeded ✅" },
      { kind: "block" },
    );
    await options.deliver(
      {
        text: "Looks like XX's Actions are all fine, last 10 runs succeeded ✅\n\nLatest was yesterday (Mar 6) v3.0.2 release, took 4m42s.",
      },
      { kind: "final" },
    );

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    const closedText = streamingInstances[0].close.mock.calls[0]?.[0] as string;
    expect(closedText).toContain("Looks like XX's Actions are all fine, last 10 runs succeeded ✅");
    expect(closedText).toContain("Latest was yesterday (Mar 6) v3.0.2 release, took 4m42s.");
    expect(closedText).not.toMatch(/Looks like.*Looks like/);
  });

  it("preserves delta and repeated block chunks from coalescer (no truncation)", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();
    // Simulate coalescer output: deltas + repeated chunks (no final payload)
    await options.deliver({ text: "Hello" }, { kind: "block" });
    await options.deliver({ text: " world" }, { kind: "block" });
    await options.deliver({ text: "!" }, { kind: "block" });
    await options.deliver({ text: "Line 1" }, { kind: "block" });
    await options.deliver({ text: "Line 1" }, { kind: "block" }); // repeated chunk
    await options.deliver({ text: "\nLine 2" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    const closedText = streamingInstances[0].close.mock.calls[0]?.[0] as string;
    expect(closedText).toBe("Hello world!Line 1Line 1\nLine 2");
  });

  it("preserves prior text when block delta starts with previous (abc,abcd->abcabcd)", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();
    // mergeStreamingText returns next when next.startsWith(previous); we must append to avoid
    // truncation (e.g. coalescer emits "abc" then "abcd", full="abcabcd").
    await options.deliver({ text: "abc" }, { kind: "block" });
    await options.deliver({ text: "abcd" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    const closedText = streamingInstances[0].close.mock.calls[0]?.[0] as string;
    expect(closedText).toBe("abcabcd");
  });

  it("preserves longer prefix-matching block deltas (abc,abcXYZ->abcabcXYZ)", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();
    // Coalescer emits independent deltas; "abc" then "abcXYZ" must append to "abcabcXYZ".
    // mergeStreamingText would return "abcXYZ" (next), dropping prior "abc" without this fix.
    await options.deliver({ text: "abc" }, { kind: "block" });
    await options.deliver({ text: "abcXYZ" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    const closedText = streamingInstances[0].close.mock.calls[0]?.[0] as string;
    expect(closedText).toBe("abcabcXYZ");
  });

  it("preserves suffix-overlap block deltas (abcd,bcdx->abcdbcdx)", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();
    // mergeStreamingText overlap-merge would produce "abcdx", dropping "bcd". Coalescer emits
    // independent deltas; we must append to get "abcdbcdx" when onIdle closes with no final.
    await options.deliver({ text: "abcd" }, { kind: "block" });
    await options.deliver({ text: "bcdx" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    const closedText = streamingInstances[0].close.mock.calls[0]?.[0] as string;
    expect(closedText).toBe("abcdbcdx");
  });

  it("preserves non-suffix repeated block deltas (ABC,DEF,ABC)", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();
    // mergeStreamingText would drop "ABC" when previous="ABCDEF" (previous.startsWith(next));
    // we must append to avoid missing text when onIdle closes with no final payload.
    await options.deliver({ text: "ABC" }, { kind: "block" });
    await options.deliver({ text: "DEF" }, { kind: "block" });
    await options.deliver({ text: "ABC" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    const closedText = streamingInstances[0].close.mock.calls[0]?.[0] as string;
    expect(closedText).toBe("ABCDEFABC");
  });

  it("sends media-only payloads as attachments", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "final" });

    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "oc_chat",
        mediaUrl: "https://example.com/a.png",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("falls back to legacy mediaUrl when mediaUrls is an empty array", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver(
      { text: "caption", mediaUrl: "https://example.com/a.png", mediaUrls: [] },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
      }),
    );
  });

  it("sends attachments after streaming final markdown replies", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver(
      { text: "```ts\nconst x = 1\n```", mediaUrls: ["https://example.com/a.png"] },
      { kind: "final" },
    );

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
      }),
    );
  });

  it("passes replyInThread to sendMessageFeishu for plain text", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "plain text" }, { kind: "final" });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("passes replyInThread to sendMarkdownCardFeishu for card text", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: false,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "card text" }, { kind: "final" });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("passes replyToMessageId and replyInThread to streaming.start()", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledWith("oc_chat", "chat_id", {
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
  });

  it("disables streaming for thread replies and keeps reply metadata", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: false,
      threadReply: true,
      rootId: "om_root_topic",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("passes replyInThread to media attachments", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "final" });

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });
});
