import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { PluginRuntime, RuntimeEnv, RuntimeLogger } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMatrixRoomMessageHandler } from "./handler.js";
import { EventType, type MatrixRawEvent } from "./types.js";

vi.mock("../draft-stream.js", () => {
  const mockDraftStream = {
    update: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue("evt-stream-1"),
    forceNewMessage: vi.fn(),
    getEventId: vi.fn().mockReturnValue("evt-stream-1"),
  };
  return {
    createMatrixDraftStream: vi.fn().mockReturnValue(mockDraftStream),
  };
});

// Also mock editMessageMatrix for in-place finalization tests
vi.mock("../send.js", () => ({
  sendMessageMatrix: vi.fn().mockResolvedValue({ messageId: "msg-1", roomId: "!room:example.org" }),
  sendTypingMatrix: vi.fn().mockResolvedValue(undefined),
  sendReadReceiptMatrix: vi.fn().mockResolvedValue(undefined),
  editMessageMatrix: vi
    .fn()
    .mockResolvedValue({ messageId: "edit-1", roomId: "!room:example.org" }),
  reactMatrixMessage: vi.fn().mockResolvedValue(undefined),
  resolveMatrixRoomId: vi.fn().mockImplementation((client: unknown, id: string) => id),
}));
import { editMessageMatrix } from "../send.js";

vi.mock("./replies.js", () => ({
  deliverMatrixReplies: vi.fn().mockResolvedValue(undefined),
}));

// Import after mock registration so we get the mocked version
import { createMatrixDraftStream } from "../draft-stream.js";

function buildCore(
  overrides: {
    withReplyDispatcherResult?: Record<string, unknown>;
    dispatchReplyFromConfigImpl?: () => Promise<unknown>;
  } = {},
) {
  let capturedOnPartialReply: ((payload: { text?: string }) => void) | undefined;
  let capturedDeliver:
    | ((payload: {
        text?: string;
        isError?: boolean;
        mediaUrl?: string;
        mediaUrls?: string[];
      }) => Promise<void>)
    | undefined;

  const dispatchReplyFromConfig = vi
    .fn()
    .mockImplementation(
      async (params: {
        replyOptions?: { onPartialReply?: (payload: { text?: string }) => void };
      }) => {
        capturedOnPartialReply = params.replyOptions?.onPartialReply;
        if (overrides.dispatchReplyFromConfigImpl) {
          return overrides.dispatchReplyFromConfigImpl();
        }
        return undefined;
      },
    );

  const core = {
    channel: {
      pairing: {
        readAllowFromStore: vi.fn().mockResolvedValue([]),
      },
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue({
          agentId: "main",
          accountId: undefined,
          sessionKey: "agent:main:matrix:channel:!room:example.org",
          mainSessionKey: "agent:main:main",
        }),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue("/tmp/openclaw-test-session.json"),
        readSessionUpdatedAt: vi.fn().mockReturnValue(123),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatInboundEnvelope: vi
          .fn()
          .mockImplementation((params: { body: string }) => params.body),
        formatAgentEnvelope: vi.fn().mockImplementation((params: { body: string }) => params.body),
        finalizeInboundContext: vi.fn().mockImplementation((ctx: Record<string, unknown>) => ctx),
        resolveHumanDelayConfig: vi.fn().mockReturnValue(undefined),
        createReplyDispatcherWithTyping: vi
          .fn()
          .mockImplementation(
            (params: {
              deliver?: (payload: {
                text?: string;
                isError?: boolean;
                mediaUrl?: string;
                mediaUrls?: string[];
              }) => Promise<void>;
            }) => {
              capturedDeliver = params.deliver;
              return {
                dispatcher: {},
                replyOptions: {},
                markDispatchIdle: vi.fn(),
              };
            },
          ),
        withReplyDispatcher: vi
          .fn()
          .mockImplementation(
            async (params: { run: () => Promise<unknown>; onSettled: () => void }) => {
              await params.run();
              // Simulate the agent dispatcher calling deliver with a final text payload
              if (capturedDeliver) {
                await capturedDeliver({ text: "final answer", isError: false });
              }
              params.onSettled();
              return (
                overrides.withReplyDispatcherResult ?? {
                  queuedFinal: false,
                  counts: { final: 0, partial: 0, tool: 0 },
                }
              );
            },
          ),
        dispatchReplyFromConfig,
      },
      commands: {
        shouldHandleTextCommands: vi.fn().mockReturnValue(true),
      },
      mentions: {
        buildMentionRegexes: vi.fn().mockReturnValue([]),
      },
      text: {
        hasControlCommand: vi.fn().mockReturnValue(false),
        resolveMarkdownTableMode: vi.fn().mockReturnValue("code"),
      },
      reactions: {
        shouldAckReaction: vi.fn().mockReturnValue(false),
      },
    },
    system: {
      enqueueSystemEvent: vi.fn(),
    },
  } as unknown as PluginRuntime;

  return { core, getCapturedOnPartialReply: () => capturedOnPartialReply };
}

function buildHandlerParams(core: PluginRuntime, cfg: Record<string, unknown> = {}) {
  const client = {
    getUserId: vi.fn().mockResolvedValue("@bot:matrix.example.org"),
  } as unknown as MatrixClient;

  const runtime = {
    error: vi.fn(),
  } as unknown as RuntimeEnv;

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as RuntimeLogger;

  const logVerboseMessage = vi.fn();

  return {
    client,
    core,
    cfg: cfg as Parameters<typeof createMatrixRoomMessageHandler>[0]["cfg"],
    runtime,
    logger,
    logVerboseMessage,
    allowFrom: [],
    roomsConfig: undefined,
    mentionRegexes: [],
    groupPolicy: "open" as const,
    replyToMode: "first" as const,
    threadReplies: "off" as const,
    dmEnabled: true,
    dmPolicy: "open" as const,
    textLimit: 4000,
    mediaMaxBytes: 5 * 1024 * 1024,
    startupMs: Date.now(),
    startupGraceMs: 60_000,
    directTracker: {
      isDirectMessage: vi.fn().mockResolvedValue(false),
    },
    getRoomInfo: vi.fn().mockResolvedValue({
      name: "Dev Room",
      canonicalAlias: "#dev:matrix.example.org",
      altAliases: [],
    }),
    getMemberDisplayName: vi.fn().mockResolvedValue("Bu"),
    accountId: undefined,
  };
}

function buildRoomMessageEvent(): MatrixRawEvent {
  return {
    type: EventType.RoomMessage,
    event_id: "$event1",
    sender: "@bu:matrix.example.org",
    origin_server_ts: Date.now(),
    content: {
      msgtype: "m.text",
      body: "hello bot",
      "m.mentions": { user_ids: ["@bot:matrix.example.org"] },
    },
  } as unknown as MatrixRawEvent;
}

describe("createMatrixRoomMessageHandler streaming behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply the default finalize mock after clearAllMocks
    const mockFn = createMatrixDraftStream as ReturnType<typeof vi.fn>;
    const impl = mockFn.getMockImplementation?.() as ((...args: unknown[]) => unknown) | undefined;
    const mockStream = impl?.();
    if (mockStream && typeof mockStream === "object" && "finalize" in mockStream) {
      (mockStream as { finalize: ReturnType<typeof vi.fn> }).finalize.mockResolvedValue(
        "evt-stream-1",
      );
    }
  });

  it("streaming disabled: createMatrixDraftStream is not called when streaming is not 'partial'", async () => {
    const { core } = buildCore();
    const params = buildHandlerParams(core, {
      channels: {
        matrix: {
          streaming: "off",
        },
      },
    });
    const handler = createMatrixRoomMessageHandler(params);
    await handler("!room:example.org", buildRoomMessageEvent());

    expect(createMatrixDraftStream).not.toHaveBeenCalled();
  });

  it("streaming disabled (no config): createMatrixDraftStream is not called when streaming is absent", async () => {
    const { core } = buildCore();
    const params = buildHandlerParams(core, {});
    const handler = createMatrixRoomMessageHandler(params);
    await handler("!room:example.org", buildRoomMessageEvent());

    expect(createMatrixDraftStream).not.toHaveBeenCalled();
  });

  it("streaming enabled: createMatrixDraftStream is called with correct params when streaming is 'partial'", async () => {
    const { core } = buildCore();
    const params = buildHandlerParams(core, {
      channels: {
        matrix: {
          streaming: "partial",
          streamThrottleMs: 500,
        },
      },
    });
    const handler = createMatrixRoomMessageHandler(params);
    await handler("!room:example.org", buildRoomMessageEvent());

    expect(createMatrixDraftStream).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "!room:example.org",
        throttleMs: 500,
        replyToId: "$event1",
      }),
    );
  });

  it("streaming enabled: draftStream.update() called on partial reply via onPartialReply", async () => {
    const { core, getCapturedOnPartialReply } = buildCore();
    const params = buildHandlerParams(core, {
      channels: {
        matrix: {
          streaming: "partial",
        },
      },
    });
    const handler = createMatrixRoomMessageHandler(params);
    await handler("!room:example.org", buildRoomMessageEvent());

    // Retrieve the mockDraftStream that was returned by createMatrixDraftStream
    const mockDraftStream = (createMatrixDraftStream as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as {
      update: ReturnType<typeof vi.fn>;
      finalize: ReturnType<typeof vi.fn>;
    };
    expect(mockDraftStream).toBeDefined();

    // Simulate a partial reply being fired
    const onPartialReply = getCapturedOnPartialReply();
    expect(onPartialReply).toBeDefined();
    onPartialReply?.({ text: "partial text" });

    expect(mockDraftStream.update).toHaveBeenCalledWith("partial text");
  });

  it("streaming enabled: draftStream.update() is NOT called when partial reply has no text", async () => {
    const { core, getCapturedOnPartialReply } = buildCore();
    const params = buildHandlerParams(core, {
      channels: {
        matrix: {
          streaming: "partial",
        },
      },
    });
    const handler = createMatrixRoomMessageHandler(params);
    await handler("!room:example.org", buildRoomMessageEvent());

    const mockDraftStream = (createMatrixDraftStream as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as {
      update: ReturnType<typeof vi.fn>;
    };

    const onPartialReply = getCapturedOnPartialReply();
    onPartialReply?.({ text: undefined });

    expect(mockDraftStream.update).not.toHaveBeenCalled();
  });

  it("streaming enabled: deliver finalizes draft in-place (no new message sent)", async () => {
    // When deliver() is called with text and a draft event exists,
    // it should edit the draft in-place rather than sending a new message.
    const { core } = buildCore();
    const params = buildHandlerParams(core, {
      channels: {
        matrix: {
          streaming: "partial",
        },
      },
    });
    const handler = createMatrixRoomMessageHandler(params);
    await handler("!room:example.org", buildRoomMessageEvent());

    const mockDraftStream = (createMatrixDraftStream as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as {
      stop: ReturnType<typeof vi.fn>;
      finalize: ReturnType<typeof vi.fn>;
    };

    // stop() should have been called to cancel pending timer
    expect(mockDraftStream.stop).toHaveBeenCalledTimes(1);
    // editMessageMatrix should have been called to finalize in-place
    expect(editMessageMatrix as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    // draftStream.finalize() should NOT be called again (already handled via editMessageMatrix)
    expect(mockDraftStream.finalize).not.toHaveBeenCalled();
  });

  it("streaming enabled: outer finalize() skipped when no draft event was created (prevents duplicate messages)", async () => {
    // When getEventId() returns null (reply finished before first throttled send),
    // deliver() already fell through to deliverMatrixReplies(). Calling finalize()
    // here would flush pending text as a duplicate second message.
    const draftStreamMock = {
      update: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      finalize: vi.fn().mockResolvedValue(null),
      forceNewMessage: vi.fn(),
      getEventId: vi.fn().mockReturnValue(null), // no event started
    };
    (createMatrixDraftStream as ReturnType<typeof vi.fn>).mockReturnValueOnce(draftStreamMock);

    const { core } = buildCore();
    const params = buildHandlerParams(core, {
      channels: {
        matrix: {
          streaming: "partial",
        },
      },
    });
    const handler = createMatrixRoomMessageHandler(params);
    await handler("!room:example.org", buildRoomMessageEvent());

    // stop() is called to drain any in-flight sends before checking getEventId()
    expect(draftStreamMock.stop).toHaveBeenCalledTimes(1);
    // forceNewMessage() called after fallback delivery to prevent outer finalize
    expect(draftStreamMock.forceNewMessage).toHaveBeenCalledTimes(1);
    // finalize() must NOT be called when no draft event exists — prevents duplicate messages
    expect(draftStreamMock.finalize).not.toHaveBeenCalled();
  });
});
