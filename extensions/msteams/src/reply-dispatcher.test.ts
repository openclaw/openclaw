import { beforeEach, describe, expect, it, vi } from "vitest";

const createChannelReplyPipelineMock = vi.hoisted(() => vi.fn());
const createReplyDispatcherWithTypingMock = vi.hoisted(() => vi.fn());
const getMSTeamsRuntimeMock = vi.hoisted(() => vi.fn());
const renderReplyPayloadsToMessagesMock = vi.hoisted(() => vi.fn(() => []));
const sendMSTeamsMessagesMock = vi.hoisted(() => vi.fn(async () => []));
const streamInstances = vi.hoisted(
  () =>
    [] as Array<{
      hasContent: boolean;
      sendInformativeUpdate: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      finalize: ReturnType<typeof vi.fn>;
    }>,
);

vi.mock("../runtime-api.js", () => ({
  createChannelReplyPipeline: createChannelReplyPipelineMock,
  logTypingFailure: vi.fn(),
  resolveChannelMediaMaxBytes: vi.fn(() => 8 * 1024 * 1024),
}));

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: getMSTeamsRuntimeMock,
}));

vi.mock("./messenger.js", () => ({
  buildConversationReference: vi.fn((ref) => ref),
  renderReplyPayloadsToMessages: renderReplyPayloadsToMessagesMock,
  sendMSTeamsMessages: sendMSTeamsMessagesMock,
}));

vi.mock("./errors.js", () => ({
  classifyMSTeamsSendError: vi.fn(() => ({})),
  formatMSTeamsSendErrorHint: vi.fn(() => undefined),
  formatUnknownError: vi.fn((err) => String(err)),
}));

vi.mock("./revoked-context.js", () => ({
  withRevokedProxyFallback: async ({ run }: { run: () => Promise<unknown> }) => await run(),
}));

vi.mock("./streaming-message.js", () => ({
  TeamsHttpStream: class {
    hasContent = false;
    sendInformativeUpdate = vi.fn(async () => {});
    update = vi.fn();
    finalize = vi.fn(async () => {});

    constructor() {
      streamInstances.push(this);
    }
  },
}));

import { createMSTeamsReplyDispatcher, pickInformativeStatusText } from "./reply-dispatcher.js";

describe("createMSTeamsReplyDispatcher", () => {
  let typingCallbacks: {
    onReplyStart: ReturnType<typeof vi.fn>;
    onIdle: ReturnType<typeof vi.fn>;
    onCleanup: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    streamInstances.length = 0;

    typingCallbacks = {
      onReplyStart: vi.fn(async () => {}),
      onIdle: vi.fn(),
      onCleanup: vi.fn(),
    };

    createChannelReplyPipelineMock.mockReturnValue({
      onModelSelected: vi.fn(),
      typingCallbacks,
    });

    createReplyDispatcherWithTypingMock.mockImplementation((options) => ({
      dispatcher: {},
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _options: options,
    }));

    getMSTeamsRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveChunkMode: vi.fn(() => "length"),
          resolveMarkdownTableMode: vi.fn(() => "code"),
        },
        reply: {
          createReplyDispatcherWithTyping: createReplyDispatcherWithTypingMock,
          resolveHumanDelayConfig: vi.fn(() => undefined),
        },
      },
    });
  });

  function createDispatcher(
    conversationType: string = "personal",
    msteamsConfig: Record<string, unknown> = {},
  ) {
    return createMSTeamsReplyDispatcher({
      cfg: { channels: { msteams: msteamsConfig } } as never,
      agentId: "agent",
      runtime: { error: vi.fn() } as never,
      log: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
      adapter: {
        continueConversation: vi.fn(),
        process: vi.fn(),
        updateActivity: vi.fn(),
        deleteActivity: vi.fn(),
      } as never,
      appId: "app",
      conversationRef: {
        conversation: { id: "conv", conversationType },
        user: { id: "user" },
        agent: { id: "bot" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
      } as never,
      context: {
        sendActivity: vi.fn(async () => ({ id: "activity-1" })),
      } as never,
      replyStyle: "thread",
      textLimit: 4000,
    });
  }

  it("sends an informative status update on reply start for personal chats", async () => {
    createDispatcher("personal");
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.onReplyStart?.();

    expect(streamInstances).toHaveLength(1);
    expect(streamInstances[0]?.sendInformativeUpdate).toHaveBeenCalledTimes(1);
    expect(typingCallbacks.onReplyStart).not.toHaveBeenCalled();
  });

  it("sends native typing indicator for channel conversations by default", async () => {
    createDispatcher("channel");
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.onReplyStart?.();

    expect(streamInstances).toHaveLength(0);
    expect(typingCallbacks.onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("skips native typing indicator when typingIndicator=false", async () => {
    createDispatcher("channel", { typingIndicator: false });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.onReplyStart?.();

    expect(typingCallbacks.onReplyStart).not.toHaveBeenCalled();
  });

  it("only sends the informative status update once", async () => {
    createDispatcher("personal");
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.onReplyStart?.();
    await options.onReplyStart?.();

    expect(streamInstances[0]?.sendInformativeUpdate).toHaveBeenCalledTimes(1);
  });

  it("forwards partial replies into the Teams stream", async () => {
    const dispatcher = createDispatcher("personal");

    await dispatcher.replyOptions.onPartialReply?.({ text: "partial response" });

    expect(streamInstances[0]?.update).toHaveBeenCalledWith("partial response");
  });

  it("does not create a stream for channel conversations", async () => {
    createDispatcher("channel");

    expect(streamInstances).toHaveLength(0);
  });

  it("sets disableBlockStreaming=false when blockStreaming=true", () => {
    const dispatcher = createDispatcher("personal", { blockStreaming: true });

    expect(dispatcher.replyOptions.disableBlockStreaming).toBe(false);
  });

  it("sets disableBlockStreaming=true when blockStreaming=false", () => {
    const dispatcher = createDispatcher("personal", { blockStreaming: false });

    expect(dispatcher.replyOptions.disableBlockStreaming).toBe(true);
  });

  it("leaves disableBlockStreaming undefined when blockStreaming is not set", () => {
    const dispatcher = createDispatcher("personal", {});

    expect(dispatcher.replyOptions.disableBlockStreaming).toBeUndefined();
  });

  it("flushes messages immediately on deliver when blockStreaming is enabled", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ content: "hello" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["id-1"] as never);

    createDispatcher("personal", { blockStreaming: true });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    // Call deliver — with blockStreaming enabled it should flush immediately
    await options.deliver({ text: "block content" });

    expect(sendMSTeamsMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("does not flush messages on deliver when blockStreaming is disabled", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ content: "hello" }] as never);

    createDispatcher("personal", { blockStreaming: false });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.deliver({ text: "block content" });

    expect(sendMSTeamsMessagesMock).not.toHaveBeenCalled();
  });
});

describe("pickInformativeStatusText", () => {
  it("selects a deterministic status line for a fixed random source", () => {
    expect(pickInformativeStatusText(() => 0)).toBe("Thinking...");
    expect(pickInformativeStatusText(() => 0.99)).toBe("Putting an answer together...");
  });
});
