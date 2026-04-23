import { beforeEach, describe, expect, it, vi } from "vitest";

type StreamingSessionStub = {
  active: boolean;
  cardId: string;
  start: ReturnType<typeof vi.fn>;
  adoptExisting: ReturnType<typeof vi.fn>;
  releaseForAdoption: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  updateThinking: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  discard: ReturnType<typeof vi.fn>;
  isActive: ReturnType<typeof vi.fn>;
};

const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const getFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());
const sendStructuredCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const createReplyDispatcherWithTypingMock = vi.hoisted(() => vi.fn());
const emitMessageSentMock = vi.hoisted(() => vi.fn());
const runMessageSendingMock = vi.hoisted(() => vi.fn());
const addTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "om_msg" })));
const removeTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => {}));
const streamingInstances = vi.hoisted((): StreamingSessionStub[] => []);

function mergeStreamingText(
  previousText: string | undefined,
  nextText: string | undefined,
): string {
  const previous = typeof previousText === "string" ? previousText : "";
  const next = typeof nextText === "string" ? nextText : "";
  if (!next) {
    return previous;
  }
  if (!previous || next === previous) {
    return next;
  }
  if (next.startsWith(previous) || next.includes(previous)) {
    return next;
  }
  if (previous.startsWith(next) || previous.includes(next)) {
    return previous;
  }
  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.slice(-overlap) === next.slice(0, overlap)) {
      return `${previous}${next.slice(overlap)}`;
    }
  }
  return `${previous}${next}`;
}

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: resolveFeishuAccountMock,
  resolveFeishuRuntimeAccount: resolveFeishuAccountMock,
}));
vi.mock("./runtime.js", () => ({ getFeishuRuntime: getFeishuRuntimeMock }));
vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
  sendMarkdownCardFeishu: sendMarkdownCardFeishuMock,
  sendStructuredCardFeishu: sendStructuredCardFeishuMock,
}));
vi.mock("./media.js", () => ({ sendMediaFeishu: sendMediaFeishuMock }));
vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));
vi.mock("./targets.js", () => ({ resolveReceiveIdType: resolveReceiveIdTypeMock }));
vi.mock("./typing.js", () => ({
  addTypingIndicator: addTypingIndicatorMock,
  removeTypingIndicator: removeTypingIndicatorMock,
}));
vi.mock("./streaming-card.js", () => {
  return {
    mergeStreamingText,
    FeishuStreamingSession: class {
      active = false;
      cardId = "stream-card-id";
      messageId = "stream-message-id";
      start = vi.fn(async () => {
        this.active = true;
      });
      adoptExisting = vi.fn(async (token?: { messageId?: string; cardId?: string }) => {
        this.active = true;
        if (token?.messageId) {
          this.messageId = token.messageId;
        }
        if (token?.cardId) {
          this.cardId = token.cardId;
        }
      });
      releaseForAdoption = vi.fn(async () => {
        this.active = false;
        return {
          cardId: this.cardId,
          messageId: this.messageId,
          sequence: 2,
          currentText: "",
          hasNote: false,
          noteText: "",
          thinkingTitle: "💭 Thinking",
          thinkingText: "⏳ Thinking...",
          thinkingExpanded: true,
          thinkingPanelRendered: true,
        };
      });
      update = vi.fn(async () => {});
      updateThinking = vi.fn(async () => {});
      close = vi.fn(async () => {
        this.active = false;
      });
      discard = vi.fn(async () => {
        this.active = false;
      });
      isActive = vi.fn(() => this.active);
      getMessageId = vi.fn(() => this.messageId);
      getResumeToken = vi.fn(() => ({
        cardId: this.cardId,
        messageId: this.messageId,
        sequence: 2,
        currentText: "",
        hasNote: false,
        noteText: "",
        thinkingTitle: "💭 Thinking",
        thinkingText: "⏳ Thinking...",
        thinkingExpanded: true,
        thinkingPanelRendered: true,
      }));

      constructor() {
        streamingInstances.push(this);
      }
    },
  };
});

import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";

async function flushAsyncTasks(iterations = 8): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
  }
}

describe("createFeishuReplyDispatcher streaming behavior", () => {
  type ReplyDispatcherArgs = Parameters<typeof createFeishuReplyDispatcher>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    streamingInstances.length = 0;
    sendMediaFeishuMock.mockResolvedValue(undefined);
    sendStructuredCardFeishuMock.mockResolvedValue(undefined);

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
      hooks: {
        hasMessageSendingHooks: () => false,
        runMessageSending: runMessageSendingMock,
        emitMessageSent: emitMessageSentMock,
      },
    });
    runMessageSendingMock.mockResolvedValue(undefined);
  });

  function setupNonStreamingAutoDispatcher() {
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

    return createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
  }

  function setupHookedAutoDispatcher() {
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
      hooks: {
        hasMessageSendingHooks: () => true,
        runMessageSending: runMessageSendingMock,
        emitMessageSent: emitMessageSentMock,
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    return {
      result,
      options: createReplyDispatcherWithTypingMock.mock.calls.at(-1)?.[0],
    };
  }

  function createRuntimeLogger() {
    return { log: vi.fn(), error: vi.fn() } as never;
  }

  function createDispatcherHarness(overrides: Partial<ReplyDispatcherArgs> = {}) {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      ...overrides,
    });

    return {
      result,
      options: createReplyDispatcherWithTypingMock.mock.calls.at(-1)?.[0],
    };
  }

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
      messageCreateTimeMs: Date.now() - 6 * 60_000,
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
      messageCreateTimeMs: Math.floor((Date.now() - 6 * 60_000) / 1000),
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

  it("does not auto-stop typing on a fixed TTL while the reply is still active", async () => {
    vi.useFakeTimers();
    try {
      createFeishuReplyDispatcher({
        cfg: {} as never,
        agentId: "agent",
        runtime: {} as never,
        chatId: "oc_chat",
        replyToMessageId: "om_parent",
        messageCreateTimeMs: Date.now(),
      });

      const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
      await options.onReplyStart?.();

      expect(addTypingIndicatorMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(removeTypingIndicatorMock).not.toHaveBeenCalled();

      await options.onIdle?.();
      await flushAsyncTasks();
      expect(removeTypingIndicatorMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps auto mode plain text on non-streaming send path", async () => {
    const { options } = createDispatcherHarness();
    await options.deliver({ text: "plain text" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("suppresses internal block payload delivery", async () => {
    const { options } = createDispatcherHarness();
    await options.deliver({ text: "internal reasoning chunk" }, { kind: "block" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
  });

  it("streams reasoning and tool state in auto mode before plain-text final content", async () => {
    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await dispatcher.replyOptions.onReasoningStream?.({ text: "reasoning...", isReasoning: true });
    await flushAsyncTasks();
    await dispatcher.replyOptions.onToolStart?.({ name: "Read", phase: "start" });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("🔧 Tool calls (1)"),
      { title: "💭 Thinking" },
    );

    await options.deliver({ text: "plain text" }, { kind: "final" });

    expect(streamingInstances[0].close).toHaveBeenCalledWith("plain text", {
      note: "Agent: agent",
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("renders first partial text chunk in auto mode once streaming starts", async () => {
    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    await dispatcher.replyOptions.onPartialReply?.({ text: "第一段答案" });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].update).toHaveBeenNthCalledWith(1, "第一段答案", {
      replace: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onIdle?.();
    expect(streamingInstances[0].close).toHaveBeenCalledWith(
      "第一段答案",
      expect.objectContaining({
        note: "Agent: agent",
        dropThinkingPanel: true,
      }),
    );
  });

  it("uses streaming session for auto mode markdown payloads", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      rootId: "om_root_topic",
    });
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].start).toHaveBeenCalledWith(
      "oc_chat",
      "chat_id",
      expect.objectContaining({
        replyToMessageId: undefined,
        replyInThread: undefined,
        rootId: "om_root_topic",
        header: { title: "agent", template: "blue" },
        note: "Agent: agent",
      }),
    );
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("closes streaming with block text when final reply is missing", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.deliver({ text: "```md\npartial answer\n```" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith(
      "```md\npartial answer\n```",
      expect.objectContaining({
        note: "Agent: agent",
        dropThinkingPanel: true,
      }),
    );
  });

  it("delivers distinct final payloads after streaming close", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.deliver({ text: "```md\n完整回复第一段\n```" }, { kind: "final" });
    await options.deliver({ text: "```md\n完整回复第一段 + 第二段\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(2);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith(
      "```md\n完整回复第一段\n```",
      expect.objectContaining({
        note: "Agent: agent",
        dropThinkingPanel: true,
      }),
    );
    expect(streamingInstances[1].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[1].close).toHaveBeenCalledWith(
      "```md\n完整回复第一段 + 第二段\n```",
      expect.objectContaining({
        note: "Agent: agent",
        dropThinkingPanel: true,
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("skips exact duplicate final text after streaming close", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.deliver({ text: "```md\n同一条回复\n```" }, { kind: "final" });
    await options.deliver({ text: "```md\n同一条回复\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith(
      "```md\n同一条回复\n```",
      expect.objectContaining({
        note: "Agent: agent",
        dropThinkingPanel: true,
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });
  it("suppresses duplicate final text while still sending media", async () => {
    const options = setupNonStreamingAutoDispatcher();
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

  it("applies message_sending rewrites before non-streaming final sends", async () => {
    runMessageSendingMock.mockResolvedValueOnce({ content: "rewritten final" });

    const options = setupNonStreamingAutoDispatcher();
    await options.deliver({ text: "plain final" }, { kind: "final" });

    expect(runMessageSendingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "oc_chat",
        content: "plain final",
      }),
      expect.objectContaining({
        channelId: "feishu",
        conversationId: "oc_chat",
      }),
    );
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "rewritten final",
      }),
    );
  });

  it("honors message_sending cancellation for media-only final sends", async () => {
    runMessageSendingMock.mockResolvedValueOnce({ cancel: true });

    const options = setupNonStreamingAutoDispatcher();
    await options.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "final" });

    // Cancelled final sends now show a policy note instead of silently discarding.
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "[Message filtered by policy]" }),
    );
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(emitMessageSentMock).not.toHaveBeenCalled();
  });

  it("keeps streaming partial text even when message_sending hooks are active", async () => {
    const { result, options } = setupHookedAutoDispatcher();
    await options.onReplyStart?.();
    await result.replyOptions.onReasoningStream?.({ text: "thinking..." });
    await result.replyOptions.onPartialReply?.({ text: "partial text" });
    await options.deliver({ text: "stream candidate" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].update).toHaveBeenCalled();
    expect(streamingInstances[0].updateThinking).toHaveBeenCalled();
    expect(streamingInstances[0].close).toHaveBeenCalledWith("stream candidate", {
      note: "Agent: agent",
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps distinct non-streaming final payloads", async () => {
    const options = setupNonStreamingAutoDispatcher();
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

  it("starts a streaming card on assistant activity in card mode", async () => {
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

    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.onReplyStart?.();
    await result.replyOptions.onPartialReply?.({ text: "hello" });
    await options.deliver({ text: "lo world" }, { kind: "block" });
    await options.onIdle?.();
    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith(
      "hello world",
      expect.objectContaining({
        note: "Agent: agent",
        dropThinkingPanel: true,
      }),
    );
  });

  it("shows accumulated reasoning and tool history while keeping streamed text separate", async () => {
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

    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await dispatcher.replyOptions.onReasoningStream?.({
      text: "Reasoning:\n_step_",
      isReasoning: true,
    });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("step\n\n⏳ Thinking"),
      {
        title: "💭 Thinking",
      },
    );

    await dispatcher.replyOptions.onToolStart?.({ name: "Read", phase: "start" });
    await flushAsyncTasks();

    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("step\n\n🔧 Tool calls (1)\n\n⏳ Running Read..."),
      { title: "💭 Thinking" },
    );

    await dispatcher.replyOptions.onPartialReply?.({ text: "第一段答案" });
    await flushAsyncTasks();
    expect(streamingInstances[0].update).toHaveBeenNthCalledWith(1, "第一段答案", {
      replace: true,
    });

    await dispatcher.replyOptions.onToolStart?.({ name: "Grep", phase: "start" });
    await flushAsyncTasks();
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      "step\n\n🔧 Tool calls (2)\n\n⏳ Running Grep...",
      { title: "💭 Thinking" },
    );

    await dispatcher.replyOptions.onPartialReply?.({ text: "第一段答案\n第二段答案" });
    await flushAsyncTasks();
    expect(streamingInstances[0].update).toHaveBeenLastCalledWith("第一段答案\n第二段答案", {
      replace: true,
    });

    await options.onIdle?.();
    expect(streamingInstances[0].close).toHaveBeenCalledWith("第一段答案\n第二段答案", {
      note: "Agent: agent",
    });
  });

  it("shows tool status even when the first visible event is a tool call", async () => {
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

    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await dispatcher.replyOptions.onToolStart?.({ name: "Read", phase: "start" });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith("⏳ Running Read...", {
      title: "🔧 Tool calls (1)",
    });

    await dispatcher.replyOptions.onPartialReply?.({ text: "第一段答案" });
    await flushAsyncTasks();

    expect(streamingInstances[0].update).toHaveBeenLastCalledWith("第一段答案", {
      replace: true,
    });

    await options.onIdle?.();
    expect(streamingInstances[0].close).toHaveBeenCalledWith("第一段答案", {
      note: "Agent: agent",
    });
  });

  it("starts the streaming card for tool-only updates in auto mode", async () => {
    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    await dispatcher.replyOptions.onToolStart?.({ name: "Read", phase: "start" });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith("⏳ Running Read...", {
      title: "🔧 Tool calls (1)",
    });
  });

  it("does not create a thinking panel for text-only streaming in auto mode", async () => {
    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    await dispatcher.replyOptions.onPartialReply?.({ text: "第一段答案" });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].updateThinking).not.toHaveBeenCalled();
    expect(streamingInstances[0].update).toHaveBeenLastCalledWith("第一段答案", {
      replace: true,
    });
  });

  it("does not render the thinking panel on assistant start without reasoning preview", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    await options.onReplyStart?.();
    result.replyOptions.onAssistantMessageStart?.();
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].updateThinking).not.toHaveBeenCalled();
  });

  it("renders the thinking panel on assistant start when reasoning preview is enabled", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      allowReasoningPreview: true,
    });

    await options.onReplyStart?.();
    result.replyOptions.onAssistantMessageStart?.();
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Thinking"),
      { title: "💭 Thinking" },
    );
  });

  it("renders the thinking panel on reply start when forced by bot-company", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      allowReasoningPreview: false,
      forceThinkingPreviewOnReplyStart: true,
    });

    await options.onReplyStart?.();
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Thinking"),
      { title: "💭 Thinking" },
    );
  });

  it("renders the thinking panel on assistant start for claude-cli even without reasoning preview", async () => {
    const runtime = { log: vi.fn(), error: vi.fn() };
    const { result, options } = createDispatcherHarness({
      runtime: runtime as never,
      allowReasoningPreview: false,
    });

    await options.onReplyStart?.();
    result.replyOptions.onModelSelected?.({
      provider: "claude-cli",
      model: "opus-4.5",
      thinkLevel: "off",
    });
    result.replyOptions.onAssistantMessageStart?.();
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Thinking"),
      { title: "💭 Thinking" },
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("thinking panel visible"));
  });

  it("logs pending thinking-card lifecycle when a queued followup preview is shown", async () => {
    const runtime = { log: vi.fn(), error: vi.fn() };
    const { result } = createDispatcherHarness({
      runtime: runtime as never,
    });

    const pending = await result.showPendingThinkingCard?.();
    await flushAsyncTasks();

    expect(pending).toEqual(
      expect.objectContaining({
        messageId: "stream-message-id",
        resumeToken: expect.objectContaining({
          cardId: "stream-card-id",
          messageId: "stream-message-id",
        }),
      }),
    );
    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].releaseForAdoption).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("showPendingThinkingCard requested"),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("showPendingThinkingCard ready messageId=stream-message-id"),
    );
  });

  it("adopts an existing pending streaming card instead of creating a new one", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      forceThinkingPreviewOnReplyStart: true,
      adoptStreamingCardToken: {
        cardId: "pending-card-id",
        messageId: "pending-message-id",
        sequence: 3,
        currentText: "",
        hasNote: false,
        noteText: "",
        thinkingTitle: "💭 Thinking",
        thinkingText: "⏳ Thinking...",
        thinkingExpanded: true,
        thinkingPanelRendered: true,
      },
    });

    await options.onReplyStart?.();
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).not.toHaveBeenCalled();
    expect(streamingInstances[0].adoptExisting).toHaveBeenCalledWith(
      expect.objectContaining({
        cardId: "pending-card-id",
        messageId: "pending-message-id",
      }),
    );
    await result.replyOptions.onPartialReply?.({ text: "hello" });
    await flushAsyncTasks();
    expect(streamingInstances[0].update).toHaveBeenCalled();
  });

  it("starts the live thinking card as soon as claude-cli model selection is known", async () => {
    const runtime = { log: vi.fn(), error: vi.fn() };
    const { result } = createDispatcherHarness({
      runtime: runtime as never,
      allowReasoningPreview: false,
      onVisibleOutputStarted: vi.fn(),
    });

    result.replyOptions.onModelSelected?.({
      provider: "claude-cli",
      model: "sonnet",
      thinkLevel: "high",
    });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenCalledWith(
      expect.stringContaining("⏳ Thinking"),
      { title: "💭 Thinking" },
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("visible output started"));
  });

  it("does not animate a thinking panel for plain text-only streaming", async () => {
    vi.useFakeTimers();
    try {
      const dispatcher = createFeishuReplyDispatcher({
        cfg: {} as never,
        agentId: "agent",
        runtime: { log: vi.fn(), error: vi.fn() } as never,
        chatId: "oc_chat",
      });

      await dispatcher.replyOptions.onPartialReply?.({ text: "第一段答案" });
      await flushAsyncTasks();

      expect(streamingInstances).toHaveLength(1);
      const updateThinking = streamingInstances[0].updateThinking;
      const baselineCalls = updateThinking.mock.calls.length;

      await vi.advanceTimersByTimeAsync(1_600);
      await flushAsyncTasks();

      expect(updateThinking.mock.calls.length).toBe(baselineCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("groups repeated tool calls instead of listing each invocation separately", async () => {
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

    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    await dispatcher.replyOptions.onToolStart?.({ name: "exec", phase: "start" });
    await dispatcher.replyOptions.onToolStart?.({ name: "exec", phase: "start" });
    await dispatcher.replyOptions.onToolStart?.({ name: "exec", phase: "start" });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Running Exec..."),
      { title: "🔧 Tool calls (3)" },
    );
  });

  it("clears running tool status once a tool result arrives", async () => {
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

    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    await dispatcher.replyOptions.onToolStart?.({ name: "memory_search", phase: "start" });
    await flushAsyncTasks();
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Running Memory Search..."),
      { title: "🔧 Tool calls (1)" },
    );

    await dispatcher.replyOptions.onToolResult?.({});
    await flushAsyncTasks();
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith("✓ Memory Search", {
      title: "🔧 Tool calls (1)",
    });
  });

  it("counts tool calls from tool results when start events are missed", async () => {
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

    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    await dispatcher.replyOptions.onAssistantMessageStart?.();
    await flushAsyncTasks();
    await dispatcher.replyOptions.onToolResult?.({
      toolCallId: "toolu_1",
      text: "README contents",
    });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith("✓ Tool", {
      title: "🔧 Tool calls (1)",
    });
  });

  it("tracks tool lifecycle from low-level agent events", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    await options.onReplyStart?.();
    await result.replyOptions.onAgentEvent?.({
      stream: "tool",
      data: {
        phase: "start",
        name: "Read",
        toolUseId: "toolu_evt_1",
      },
    });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Running Read..."),
      { title: "🔧 Tool calls (1)" },
    );

    await result.replyOptions.onAgentEvent?.({
      stream: "tool",
      data: {
        phase: "result",
        toolUseId: "toolu_evt_1",
        result: "README contents",
      },
    });
    await flushAsyncTasks();

    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith("✓ Read", {
      title: "🔧 Tool calls (1)",
    });
  });

  it("shows read targets in the feishu thinking panel when tool args are available", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    await options.onReplyStart?.();
    await result.replyOptions.onAgentEvent?.({
      stream: "tool",
      data: {
        phase: "start",
        name: "read",
        toolCallId: "tool-read-path",
        args: {
          file_path: "/tmp/README.md",
          offset: 10,
          limit: 5,
        },
      },
    });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("Read — lines 10-14 from /tmp/README.md"),
      { title: "🔧 Tool calls (1)" },
    );
  });

  it("shows read targets in the feishu thinking panel when low-level tool events still use input", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    await options.onReplyStart?.();
    await result.replyOptions.onAgentEvent?.({
      stream: "tool",
      data: {
        phase: "start",
        name: "read",
        toolCallId: "tool-read-input",
        input: {
          file_path: "/tmp/README.md",
          offset: 10,
          limit: 5,
        },
      },
    });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("Read — lines 10-14 from /tmp/README.md"),
      { title: "🔧 Tool calls (1)" },
    );
  });

  it("shows exec commands in the feishu thinking panel when tool args are available", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    await options.onReplyStart?.();
    await result.replyOptions.onAgentEvent?.({
      stream: "tool",
      data: {
        phase: "start",
        name: "exec",
        toolCallId: "tool-exec-command",
        args: {
          command: "cd /tmp/project && pnpm vitest run src/agents/tool-display.test.ts",
        },
      },
    });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("Exec — run pnpm vitest"),
      { title: "🔧 Tool calls (1)" },
    );
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining(
        "`cd /tmp/project && pnpm vitest run src/agents/tool-display.test.ts`",
      ),
      { title: "🔧 Tool calls (1)" },
    );
  });

  it("truncates very long tool summaries so feishu cards stay compact", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    const longPath = `/tmp/${"very-long-segment/".repeat(16)}ENDMARKER.txt`;

    await options.onReplyStart?.();
    await result.replyOptions.onAgentEvent?.({
      stream: "tool",
      data: {
        phase: "start",
        name: "read",
        toolCallId: "tool-read-long",
        args: {
          file_path: longPath,
          offset: 10,
          limit: 5,
        },
      },
    });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    const call = streamingInstances[0].updateThinking.mock.lastCall;
    expect(call?.[1]).toEqual({ title: "🔧 Tool calls (1)" });
    const panelText = String(call?.[0] ?? "");
    expect(panelText).toContain("Read — lines 10-14 from /tmp/");
    expect(panelText).toContain("…");
    expect(panelText).not.toContain("ENDMARKER.txt");
    expect(panelText.length).toBeLessThan(260);
  });

  it("shows bash command context instead of only the tool name", async () => {
    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    await dispatcher.replyOptions.onToolStart?.({
      name: "Bash",
      phase: "start",
      args: {
        command: "cd ~/Projects/lm-router && npm test",
      },
    });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("Bash — run tests"),
      { title: "🔧 Tool calls (1)" },
    );
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("`cd ~/Projects/lm-router && npm test`"),
      { title: "🔧 Tool calls (1)" },
    );
  });

  it("clears running tool status as soon as assistant text starts streaming", async () => {
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

    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    await dispatcher.replyOptions.onToolStart?.({ name: "Bash", phase: "start" });
    await flushAsyncTasks();
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Running Bash..."),
      { title: "🔧 Tool calls (1)" },
    );

    await dispatcher.replyOptions.onPartialReply?.({ text: "final answer" });
    await flushAsyncTasks();
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Streaming reply"),
      {
        title: "🔧 Tool calls (1)",
      },
    );
  });

  it("keeps the tool-only final panel in the closing card", async () => {
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

    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await dispatcher.replyOptions.onToolStart?.({ name: "Read", phase: "start" });
    await flushAsyncTasks();
    await dispatcher.replyOptions.onPartialReply?.({ text: "第一段答案" });
    await flushAsyncTasks();

    await options.onIdle?.();

    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith("✓ 1 completed", {
      title: "🔧 Tool calls (1)",
    });
    expect(streamingInstances[0].close).toHaveBeenCalledWith("第一段答案", {
      note: "Agent: agent",
    });
  });

  it("keeps the tool-only final panel when card note is disabled", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
        cardNote: false,
      },
    });

    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await dispatcher.replyOptions.onToolStart?.({ name: "Read", phase: "start" });
    await flushAsyncTasks();
    await dispatcher.replyOptions.onPartialReply?.({ text: "第一段答案" });
    await flushAsyncTasks();
    await options.onIdle?.();

    expect(streamingInstances[0].close).toHaveBeenCalledWith("第一段答案", {});
  });

  it("clears running tool status when visible assistant text arrives through block delivery", async () => {
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

    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await dispatcher.replyOptions.onToolStart?.({ name: "Bash", phase: "start" });
    await flushAsyncTasks();
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Running Bash..."),
      { title: "🔧 Tool calls (1)" },
    );

    await options.deliver({ text: "visible block text" }, { kind: "block" });
    await flushAsyncTasks();
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Streaming reply"),
      {
        title: "🔧 Tool calls (1)",
      },
    );
  });

  it("does not reset cumulative tool count when onReplyStart fires again mid-reply", async () => {
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

    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.onReplyStart?.();
    await dispatcher.replyOptions.onToolStart?.({ name: "Read", phase: "start" });
    await flushAsyncTasks();
    await options.onReplyStart?.();
    await dispatcher.replyOptions.onToolStart?.({ name: "Grep", phase: "start" });
    await flushAsyncTasks();

    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Running Grep..."),
      { title: "🔧 Tool calls (2)" },
    );
  });

  it("shows running status again when a new tool starts after earlier text streaming", async () => {
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

    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    await dispatcher.replyOptions.onToolStart?.({ name: "Read", phase: "start" });
    await flushAsyncTasks();
    await dispatcher.replyOptions.onPartialReply?.({ text: "第一段答案" });
    await flushAsyncTasks();
    await dispatcher.replyOptions.onToolStart?.({ name: "Grep", phase: "start" });
    await flushAsyncTasks();

    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith("⏳ Running Grep...", {
      title: "🔧 Tool calls (2)",
    });
  });

  it("tracks unnamed tool starts as generic tool entries instead of reusing the previous name", async () => {
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

    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    await dispatcher.replyOptions.onToolStart?.({ name: "Bash", phase: "start" });
    await dispatcher.replyOptions.onToolStart?.({ phase: "start" });
    await flushAsyncTasks();

    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Running Tool..."),
      { title: "🔧 Tool calls (2)" },
    );
  });

  it("removes the correct active tool when tool results arrive out of order", async () => {
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

    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    await dispatcher.replyOptions.onToolStart?.({
      name: "memory_search",
      phase: "start",
      toolCallId: "tool-memory",
    });
    await dispatcher.replyOptions.onToolStart?.({
      name: "exec",
      phase: "start",
      toolCallId: "tool-exec",
    });
    await flushAsyncTasks();
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Running Exec..."),
      { title: "🔧 Tool calls (2)" },
    );

    await dispatcher.replyOptions.onToolResult?.({ toolCallId: "tool-memory" });
    await flushAsyncTasks();
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Running Exec..."),
      { title: "🔧 Tool calls (2)" },
    );
  });

  it("restores the previous running tool when nested tool activity unwinds", async () => {
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

    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    await dispatcher.replyOptions.onToolStart?.({ name: "memory_search", phase: "start" });
    await dispatcher.replyOptions.onToolStart?.({ name: "exec", phase: "start" });
    await flushAsyncTasks();
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Running Exec..."),
      { title: "🔧 Tool calls (2)" },
    );

    await dispatcher.replyOptions.onToolResult?.({});
    await flushAsyncTasks();
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Running Memory Search..."),
      { title: "🔧 Tool calls (2)" },
    );
  });

  it("only groups consecutive repeated tool calls so chronology stays intact", async () => {
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

    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    await dispatcher.replyOptions.onToolStart?.({ name: "exec", phase: "start" });
    await dispatcher.replyOptions.onToolStart?.({ name: "read", phase: "start" });
    await dispatcher.replyOptions.onToolStart?.({ name: "exec", phase: "start" });
    await flushAsyncTasks();

    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      expect.stringContaining("⏳ Running Exec..."),
      { title: "🔧 Tool calls (3)" },
    );
  });

  it("sends media-only payloads as attachments", async () => {
    const { options } = createDispatcherHarness();
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
    const { options } = createDispatcherHarness();
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
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
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
    const { options } = createDispatcherHarness({
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
    await options.deliver({ text: "plain text" }, { kind: "final" });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("passes replyInThread to sendStructuredCardFeishu for card text", async () => {
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

    const { options } = createDispatcherHarness({
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
    await options.deliver({ text: "card text" }, { kind: "final" });

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("streams reasoning content into the live thinking panel before the answer", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      allowReasoningPreview: true,
    });

    await options.onReplyStart?.();
    // Core agent sends pre-formatted text from formatReasoningMessage
    result.replyOptions.onReasoningStream?.({ text: "Reasoning:\n_thinking step 1_" });
    result.replyOptions.onReasoningStream?.({
      text: "Reasoning:\n_thinking step 1_\n_step 2_",
    });
    result.replyOptions.onPartialReply?.({ text: "answer part" });
    result.replyOptions.onReasoningEnd?.();
    await options.deliver({ text: "answer part final" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    const thinkingCalls = streamingInstances[0].updateThinking.mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );
    expect(thinkingCalls.at(-1)).toContain("thinking step 1");
    expect(thinkingCalls.at(-1)).toContain("step 2");
    expect(thinkingCalls.at(-1)).not.toContain("Reasoning:");
    expect(streamingInstances[0].close).toHaveBeenCalledWith("answer part final", {
      note: "Agent: agent",
    });
  });

  it("strips inline reply tags from live reasoning preview content", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      allowReasoningPreview: true,
    });

    await options.onReplyStart?.();
    result.replyOptions.onReasoningStream?.({
      text: "Reasoning:\n[[reply_to_current]] 好，我去克隆下来扫一遍代码。",
    });
    result.replyOptions.onPartialReply?.({ text: "answer part" });
    result.replyOptions.onReasoningEnd?.();
    await options.deliver({ text: "answer part final" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    const thinkingCalls = streamingInstances[0].updateThinking.mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );
    expect(thinkingCalls.at(-1)).toContain("好，我去克隆下来扫一遍代码。");
    expect(thinkingCalls.at(-1)).not.toContain("[[reply_to_current]]");
  });

  it("accumulates fragmented reasoning payloads in the live thinking panel", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    await options.onReplyStart?.();
    result.replyOptions.onReasoningStream?.({ text: "Reasoning:\n_step one_" });
    result.replyOptions.onReasoningStream?.({ text: "step two" });
    result.replyOptions.onReasoningStream?.({ text: "step three" });
    result.replyOptions.onPartialReply?.({ text: "answer part" });
    result.replyOptions.onReasoningEnd?.();
    await options.deliver({ text: "answer part final" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    const thinkingCalls = streamingInstances[0].updateThinking.mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );
    expect(thinkingCalls.at(-1)).toContain("step one");
    expect(thinkingCalls.at(-1)).toContain("step two");
    expect(thinkingCalls.at(-1)).toContain("step three");
  });

  it("provides onReasoningStream and onReasoningEnd when reasoning previews are allowed", () => {
    const { result } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      allowReasoningPreview: true,
    });

    expect(result.replyOptions.onReasoningStream).toBeTypeOf("function");
    expect(result.replyOptions.onReasoningEnd).toBeTypeOf("function");
  });

  it("keeps reasoning callbacks when streaming is disabled so final cards can include thinking", () => {
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

    const { result } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    expect(result.replyOptions.onReasoningStream).toBeTypeOf("function");
    expect(result.replyOptions.onReasoningEnd).toBeTypeOf("function");
  });

  it("preserves reasoning-only streaming cards when no answer text arrives", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      allowReasoningPreview: true,
    });

    await options.onReplyStart?.();
    result.replyOptions.onReasoningStream?.({ text: "Reasoning:\n_deep thought_" });
    result.replyOptions.onReasoningEnd?.();
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenCalledWith("deep thought", {
      title: "💭 Thinking",
    });
    expect(streamingInstances[0].discard).not.toHaveBeenCalled();
    expect(streamingInstances[0].close).toHaveBeenCalledWith("", {
      note: "Agent: agent",
    });
  });

  it("ignores empty reasoning payloads", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      allowReasoningPreview: true,
    });

    await options.onReplyStart?.();
    result.replyOptions.onReasoningStream?.({ text: "" });
    result.replyOptions.onPartialReply?.({ text: "```ts\ncode\n```" });
    await options.deliver({ text: "```ts\ncode\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    const closeArg = streamingInstances[0].close.mock.calls[0][0] as string;
    expect(closeArg).not.toContain("Thinking");
    expect(closeArg).toBe("```ts\ncode\n```");
  });

  it("strips directive tags at render time while preserving raw streamText for final delivery", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      allowReasoningPreview: false,
    });

    await options.onReplyStart?.();
    result.replyOptions.onPartialReply?.({ text: "[[reply_to_current]] hello" });
    await flushAsyncTasks();
    await options.deliver({ text: "[[reply_to_current]] hello final" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    // Render-only copy strips the directive tag (no `\s*` padding, so the
    // single space after `]]` survives) while leaving the underlying raw
    // streamText intact for final delivery bookkeeping.
    expect(streamingInstances[0].update).toHaveBeenCalledWith(" hello", {
      replace: true,
    });
    // Final delivery still strips directive tags before sending.
    expect(streamingInstances[0].close).toHaveBeenCalledWith(
      "  hello final",
      expect.objectContaining({
        note: "Agent: agent",
        dropThinkingPanel: true,
      }),
    );
  });

  it("strips inline directive tags anywhere in partial text and preserves markdown table rows", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      allowReasoningPreview: false,
    });

    const partial = [
      "| col | val |",
      "|---|---|",
      "| a | 1 [[audio_as_voice]] |",
      "| b | 2 |",
    ].join("\n");

    await options.onReplyStart?.();
    result.replyOptions.onPartialReply?.({ text: partial });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    // The audio_as_voice tag mid-cell is removed, but the newline separating
    // table rows is preserved — markdown rows must not collapse.
    const expected = ["| col | val |", "|---|---|", "| a | 1  |", "| b | 2 |"].join("\n");
    expect(streamingInstances[0].update).toHaveBeenCalledWith(expected, {
      replace: true,
    });
  });

  it("strips [[audio_as_voice]] from partial render when it leads the text", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      allowReasoningPreview: false,
    });

    await options.onReplyStart?.();
    result.replyOptions.onPartialReply?.({ text: "[[audio_as_voice]]\n\nhi" });
    await flushAsyncTasks();

    expect(streamingInstances).toHaveLength(1);
    // Directive tag is removed from the rendered card without eating the
    // surrounding newlines, so downstream markdown rendering stays intact.
    expect(streamingInstances[0].update).toHaveBeenCalledWith("\n\nhi", {
      replace: true,
    });
  });

  it("deduplicates final text by raw answer payload, not combined card text", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      allowReasoningPreview: true,
    });

    await options.onReplyStart?.();
    result.replyOptions.onReasoningStream?.({ text: "Reasoning:\n_thought_" });
    result.replyOptions.onReasoningEnd?.();
    await options.deliver({ text: "```ts\nfinal answer\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);

    // Deliver the same raw answer text again — should be deduped
    await options.deliver({ text: "```ts\nfinal answer\n```" }, { kind: "final" });

    // No second streaming session since the raw answer text matches
    expect(streamingInstances).toHaveLength(1);
  });

  it("passes replyToMessageId and replyInThread to streaming.start()", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledWith(
      "oc_chat",
      "chat_id",
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
        header: { title: "agent", template: "blue" },
        note: "Agent: agent",
      }),
    );
  });

  it("disables streaming for thread replies and keeps reply metadata", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      replyToMessageId: "om_msg",
      replyInThread: false,
      threadReply: true,
      rootId: "om_root_topic",
    });
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("keeps thinking as a collapsible panel for non-streaming card replies", async () => {
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

    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      replyToMessageId: "om_msg",
      replyInThread: false,
      threadReply: true,
      rootId: "om_root_topic",
    });

    await result.replyOptions.onReasoningStream?.({ text: "Reasoning:\n_step one_\n_step two_" });
    await result.replyOptions.onReasoningEnd?.();
    await options.deliver({ text: "final answer" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "final answer",
        thinkingTitle: "💭 Thinking",
        thinkingText: "step one\nstep two",
        thinkingExpanded: false,
      }),
    );
  });

  it("accumulates fragmented reasoning payloads for non-streaming card replies", async () => {
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

    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      replyToMessageId: "om_msg",
      replyInThread: false,
      threadReply: true,
      rootId: "om_root_topic",
    });

    await result.replyOptions.onReasoningStream?.({ text: "Reasoning:\n_step one_" });
    await result.replyOptions.onReasoningStream?.({ text: "step two" });
    await result.replyOptions.onReasoningStream?.({ text: "step three" });
    await result.replyOptions.onReasoningEnd?.();
    await options.deliver({ text: "final answer" }, { kind: "final" });

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "final answer",
        thinkingTitle: "💭 Thinking",
        thinkingText: "step one\n\nstep two\n\nstep three",
        thinkingExpanded: false,
      }),
    );
  });

  it("strips inline reply tags from non-streaming reasoning cards", async () => {
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

    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      replyToMessageId: "om_msg",
      replyInThread: false,
      threadReply: true,
      rootId: "om_root_topic",
    });

    await result.replyOptions.onReasoningStream?.({
      text: "Reasoning:\n[[reply_to_current]] thinking step",
    });
    await result.replyOptions.onReasoningEnd?.();
    await options.deliver({ text: "final answer" }, { kind: "final" });

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "final answer",
        thinkingTitle: "💭 Thinking",
        thinkingText: "thinking step",
        thinkingExpanded: false,
      }),
    );
  });

  it("deduplicates identical final card sends in non-streaming mode", async () => {
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

    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      replyToMessageId: "om_msg",
      replyInThread: false,
      threadReply: true,
      rootId: "om_root_topic",
    });

    await options.deliver({ text: "same final text" }, { kind: "final" });
    await options.deliver({ text: "same final text" }, { kind: "final" });

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates streaming final card sends when mention tag syntax differs", async () => {
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

    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      replyToMessageId: "om_msg",
      replyInThread: false,
    });

    await options.deliver(
      { text: '<at user_id="ou_trent">Trent</at> same final text' },
      { kind: "final" },
    );
    await options.deliver({ text: "<at id=ou_trent></at> same final text" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
  });

  it("deduplicates a duplicate final after streaming card already closed on idle", async () => {
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

    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      replyToMessageId: "om_msg",
      replyInThread: false,
    });

    await options.onReplyStart?.();
    await result.replyOptions.onPartialReply?.({ text: "same final text" });
    await options.onIdle?.();
    await options.deliver({ text: "same final text" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("deduplicates a post-idle final that only differs by an auto-appended reply mention", async () => {
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
      hooks: {
        hasMessageSendingHooks: () => true,
        runMessageSending: runMessageSendingMock,
        emitMessageSent: emitMessageSentMock,
      },
    });
    runMessageSendingMock.mockResolvedValueOnce({
      content: 'same final text <at user_id="ou_lukin">Lukin</at>',
    });

    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      replyToMessageId: "om_parent",
    });

    await options.onReplyStart?.();
    await result.replyOptions.onPartialReply?.({ text: "same final text" });
    await options.onIdle?.();
    await options.deliver({ text: "same final text" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("preserves reasoning/tool cards when no final assistant text arrives", async () => {
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

    const dispatcher = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    await dispatcher.replyOptions.onReasoningStream?.({ text: "thinking", isReasoning: true });
    await flushAsyncTasks();
    await dispatcher.replyOptions.onToolStart?.({ name: "Read", phase: "start" });
    await flushAsyncTasks();

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].updateThinking).toHaveBeenLastCalledWith(
      "thinking\n\n🔧 Tool calls (1)",
      { title: "💭 Thinking" },
    );
    expect(streamingInstances[0].discard).not.toHaveBeenCalled();
    expect(streamingInstances[0].close).toHaveBeenCalledWith("", {
      note: "Agent: agent",
    });
  });

  it("discards reasoning/tool cards on error when no final assistant text arrives", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    await options.onReplyStart?.();
    await result.replyOptions.onReasoningStream?.({ text: "thinking", isReasoning: true });
    await flushAsyncTasks();
    await result.replyOptions.onToolStart?.({ name: "Read", phase: "start" });
    await flushAsyncTasks();
    await options.onError?.(new Error("boom"), { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].discard).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).not.toHaveBeenCalled();
  });

  it("passes replyInThread to media attachments", async () => {
    const { options } = createDispatcherHarness({
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
    await options.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "final" });

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  // Test D: onIdle fires while deliverInFlight is true → typingCallbacks.onIdle NOT called immediately
  it("does not call typingCallbacks.onIdle immediately when onIdle fires during deliverInFlight", async () => {
    let resolveHook!: () => void;
    runMessageSendingMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveHook = resolve;
      }),
    );

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Date.now(),
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.(); // starts typing indicator
    expect(addTypingIndicatorMock).toHaveBeenCalledTimes(1);

    // Start a deliver — deliverInFlight will be set to true synchronously
    // before the hook is awaited. The promise intentionally never resolves yet.
    const deliverPromise = options.deliver({ text: "hello" }, { kind: "final" });

    // Yield one microtask so the deliver reaches and awaits the hook call
    await Promise.resolve();

    // Fire onIdle while the hook is still pending (deliverInFlight === true).
    // The new code must defer — NOT call typingCallbacks.onIdle() yet.
    await options.onIdle?.();

    // Typing should NOT have been stopped yet.
    expect(removeTypingIndicatorMock).not.toHaveBeenCalled();

    // Resolve the hook so deliver can complete
    resolveHook();
    await deliverPromise;
    await flushAsyncTasks();

    // After deliver settles, the deferred idle should fire and stop typing.
    expect(removeTypingIndicatorMock).toHaveBeenCalledTimes(1);
    // No streaming session was created (plain text path) — nothing left open.
    expect(streamingInstances).toHaveLength(0);
  });

  // Test E: After deliver completes (deliverInFlight cleared), the deferred typingCallbacks.onIdle fires
  it("flushes deferred typingCallbacks.onIdle in deliver finally once deliverInFlight is cleared", async () => {
    let resolveHook!: (value?: unknown) => void;
    runMessageSendingMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveHook = resolve;
      }),
    );

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Date.now(),
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    // Kick off deliver without awaiting — it will set deliverInFlight and suspend
    const deliverPromise = options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });
    await Promise.resolve();

    // Trigger idle while deliver is pending
    const idlePromise = options.onIdle?.();
    await idlePromise;

    // Typing still active — idle was deferred
    expect(removeTypingIndicatorMock).not.toHaveBeenCalled();

    // Complete the hook — deliver.finally should now flush the pending idle
    resolveHook();
    await deliverPromise;
    await flushAsyncTasks();

    // Deferred idle fired: typing indicator removed exactly once
    expect(removeTypingIndicatorMock).toHaveBeenCalledTimes(1);
    expect(addTypingIndicatorMock).toHaveBeenCalledTimes(1);
    // Streaming card was closed by the deferred idle path — not left in dirty/open state.
    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
  });

  it("recovers streaming after start() throws (HTTP 400)", async () => {
    const errorMock = vi.fn();
    let shouldFailStart = true;

    // Intercept streaming instance creation to make first start() reject
    const origPush = streamingInstances.push.bind(streamingInstances);
    streamingInstances.push = (...args: StreamingSessionStub[]) => {
      if (shouldFailStart) {
        args[0].start = vi
          .fn()
          .mockRejectedValue(new Error("Create card request failed with HTTP 400"));
        shouldFailStart = false;
      }
      return origPush(...args);
    };

    try {
      createFeishuReplyDispatcher({
        cfg: {} as never,
        agentId: "agent",
        runtime: { log: vi.fn(), error: errorMock } as never,
        chatId: "oc_chat",
      });

      const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

      // First deliver with markdown triggers startStreaming - which will fail
      await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "block" });

      // Wait for the async error to propagate
      await vi.waitFor(() => {
        expect(errorMock).toHaveBeenCalledWith(expect.stringContaining("streaming start failed"));
      });

      // Second deliver should create a NEW streaming session (not stuck)
      await options.deliver({ text: "```ts\nconst y = 2\n```" }, { kind: "final" });

      // Two instances created: first failed, second succeeded and closed
      expect(streamingInstances).toHaveLength(2);
      expect(streamingInstances[1].start).toHaveBeenCalled();
      expect(streamingInstances[1].close).toHaveBeenCalled();
    } finally {
      streamingInstances.push = origPush;
    }
  });
});
