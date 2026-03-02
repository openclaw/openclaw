import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../../types.js";
import { setMatrixRuntime } from "../../runtime.js";
import { fetchEventSummary } from "../actions/summary.js";
import { createMatrixRoomMessageHandler, resolveMatrixSessionKey } from "./handler.js";
import { EventType, RelationType, type MatrixRawEvent } from "./types.js";

vi.mock("../actions/summary.js", () => ({
  fetchEventSummary: vi.fn(),
}));

vi.mock("../send.js", () => ({
  reactMatrixMessage: vi.fn().mockResolvedValue(undefined),
  sendMessageMatrix: vi.fn().mockResolvedValue(undefined),
  sendReadReceiptMatrix: vi.fn().mockResolvedValue(undefined),
  sendTypingMatrix: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./replies.js", () => ({
  deliverMatrixReplies: vi.fn().mockResolvedValue(undefined),
}));

describe("resolveMatrixSessionKey", () => {
  it("keeps per-room session key when sessionScope is room", () => {
    const resolved = resolveMatrixSessionKey({
      sessionScope: "room",
      route: {
        agentId: "main",
        sessionKey: "agent:main:matrix:channel:!room:example.org",
      },
    });

    expect(resolved).toEqual({
      sessionKey: "agent:main:matrix:channel:!room:example.org",
      parentSessionKey: undefined,
    });
  });

  it("defaults to per-room session key when sessionScope is not set", () => {
    const resolved = resolveMatrixSessionKey({
      route: {
        agentId: "main",
        sessionKey: "agent:main:matrix:channel:!room:example.org",
      },
    });

    expect(resolved).toEqual({
      sessionKey: "agent:main:matrix:channel:!room:example.org",
      parentSessionKey: undefined,
    });
  });

  it("uses shared agent matrix session when sessionScope is agent", () => {
    const resolved = resolveMatrixSessionKey({
      sessionScope: "agent",
      route: {
        agentId: "Main-Agent",
        sessionKey: "agent:main-agent:matrix:channel:!room:example.org",
      },
    });

    expect(resolved).toEqual({
      sessionKey: "agent:main-agent:matrix:main",
      parentSessionKey: undefined,
    });
  });

  it("creates thread-scoped session key for room thread messages", () => {
    const resolved = resolveMatrixSessionKey({
      sessionScope: "room",
      route: {
        agentId: "main",
        sessionKey: "agent:main:matrix:channel:!room:example.org",
      },
      threadRootId: "$ThreadRoot:Example.Org",
      isDirectMessage: false,
    });

    expect(resolved).toEqual({
      sessionKey: "agent:main:matrix:channel:!room:example.org:thread:$ThreadRoot:Example.Org",
      parentSessionKey: "agent:main:matrix:channel:!room:example.org",
    });
  });

  it("keeps thread isolation when sessionScope is agent", () => {
    const resolved = resolveMatrixSessionKey({
      sessionScope: "agent",
      route: {
        agentId: "Main-Agent",
        sessionKey: "agent:main-agent:matrix:channel:!room:example.org",
      },
      threadRootId: "$ThreadRoot:Example.Org",
      isDirectMessage: false,
    });

    expect(resolved).toEqual({
      sessionKey: "agent:main-agent:matrix:main:thread:$ThreadRoot:Example.Org",
      parentSessionKey: "agent:main-agent:matrix:main",
    });
  });

  it("does not create thread session for direct messages", () => {
    const resolved = resolveMatrixSessionKey({
      sessionScope: "room",
      route: {
        agentId: "main",
        sessionKey: "agent:main:matrix:direct:@alice:example.org",
      },
      threadRootId: "$ThreadRoot:Example.Org",
      isDirectMessage: true,
    });

    expect(resolved).toEqual({
      sessionKey: "agent:main:matrix:direct:@alice:example.org",
      parentSessionKey: undefined,
    });
  });

  it("keeps per-sender DM session when sessionScope is agent", () => {
    const resolved = resolveMatrixSessionKey({
      sessionScope: "agent",
      route: {
        agentId: "Main-Agent",
        sessionKey: "agent:main-agent:matrix:direct:@alice:example.org",
      },
      threadRootId: "$ThreadRoot:Example.Org",
      isDirectMessage: true,
    });

    expect(resolved).toEqual({
      sessionKey: "agent:main-agent:matrix:direct:@alice:example.org",
      parentSessionKey: undefined,
    });
  });

  it("preserves threadRootId case", () => {
    const resolved = resolveMatrixSessionKey({
      sessionScope: "room",
      route: {
        agentId: "main",
        sessionKey: "agent:main:matrix:channel:!room:example.org",
      },
      threadRootId: "$UPPERCASE:THREAD.ID",
      isDirectMessage: false,
    });

    expect(resolved.sessionKey).toBe(
      "agent:main:matrix:channel:!room:example.org:thread:$UPPERCASE:THREAD.ID",
    );
  });

  it("trims whitespace from threadRootId", () => {
    const resolved = resolveMatrixSessionKey({
      sessionScope: "room",
      route: {
        agentId: "main",
        sessionKey: "agent:main:matrix:channel:!room:example.org",
      },
      threadRootId: "  \$thread:event.org  ",
      isDirectMessage: false,
    });

    expect(resolved.sessionKey).toBe(
      "agent:main:matrix:channel:!room:example.org:thread:\$thread:event.org",
    );
  });

  it("normalizes agentId to lowercase when sessionScope is agent", () => {
    const resolved = resolveMatrixSessionKey({
      sessionScope: "agent",
      route: {
        agentId: "UPPER_AGENT",
        sessionKey: "agent:upper_agent:matrix:channel:!room:example.org",
      },
    });

    expect(resolved.sessionKey).toBe("agent:upper_agent:matrix:main");
  });

  it("trims whitespace from agentId when sessionScope is agent", () => {
    const resolved = resolveMatrixSessionKey({
      sessionScope: "agent",
      route: {
        agentId: "  my-agent  ",
        sessionKey: "agent:my-agent:matrix:channel:!room:example.org",
      },
    });

    expect(resolved.sessionKey).toBe("agent:my-agent:matrix:main");
  });

  it("uses 'main' as fallback when agentId is empty with agent scope", () => {
    const resolved = resolveMatrixSessionKey({
      sessionScope: "agent",
      route: {
        agentId: "   ",
        sessionKey: "agent::matrix:channel:!room:example.org",
      },
    });

    expect(resolved.sessionKey).toBe("agent:main:matrix:main");
  });

  it("combines thread isolation with agent scope normalization", () => {
    const resolved = resolveMatrixSessionKey({
      sessionScope: "agent",
      route: {
        agentId: "MyAgent",
        sessionKey: "agent:myagent:matrix:channel:!room:example.org",
      },
      threadRootId: "$MixedCase:Thread.ID",
      isDirectMessage: false,
    });

    expect(resolved).toEqual({
      sessionKey: "agent:myagent:matrix:main:thread:$MixedCase:Thread.ID",
      parentSessionKey: "agent:myagent:matrix:main",
    });
  });
});

describe("createMatrixRoomMessageHandler thread starter fallback behavior", () => {
  const mockedFetchEventSummary = vi.mocked(fetchEventSummary);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("continues processing and records session when thread starter fetch returns undefined", async () => {
    mockedFetchEventSummary.mockResolvedValueOnce(undefined);
    const harness = createThreadRetryHarness();

    await harness.handler("!room:example.org", createThreadMessageEvent());

    expect(mockedFetchEventSummary).toHaveBeenCalledWith(
      harness.client,
      "!room:example.org",
      "$ThreadRoot:Example.Org",
    );
    expect(harness.mockRecordInboundSession).toHaveBeenCalledTimes(1);
    expect(harness.mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);

    const dispatchArgs = harness.mockDispatchReplyFromConfig.mock.calls[0]?.[0] as {
      ctx: Record<string, unknown>;
    };
    expect(dispatchArgs.ctx.ParentSessionKey).toBe("agent:main:matrix:channel:!room:example.org");
    expect(dispatchArgs.ctx.ThreadStarterBody).toBeUndefined();
    expect(harness.logVerboseMessage).toHaveBeenCalledWith(
      expect.stringContaining("continuing without thread starter"),
    );
  });

  it("continues processing and records session when thread starter fetch throws", async () => {
    mockedFetchEventSummary.mockRejectedValueOnce(new Error("boom"));
    const harness = createThreadRetryHarness();

    await harness.handler("!room:example.org", createThreadMessageEvent());

    expect(harness.mockRecordInboundSession).toHaveBeenCalledTimes(1);
    expect(harness.mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(harness.logVerboseMessage).toHaveBeenCalledWith(
      expect.stringContaining("continuing without thread starter"),
    );
  });

  it("uses resolved thread session key when checking existing thread sessions", async () => {
    const threadSessionKey = "agent:main:matrix:main:thread:$ThreadRoot:Example.Org";
    const harness = createThreadRetryHarness({
      cfg: {
        channels: {
          matrix: {
            sessionScope: "agent",
          },
        },
      },
      readSessionUpdatedAt: ({ sessionKey }) =>
        sessionKey === threadSessionKey ? Date.now() : undefined,
    });

    await harness.handler("!room:example.org", createThreadMessageEvent());

    expect(harness.mockReadSessionUpdatedAt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: threadSessionKey }),
    );
    expect(mockedFetchEventSummary).not.toHaveBeenCalled();
    expect(harness.mockRecordInboundSession).toHaveBeenCalledTimes(1);
  });
});

function createThreadMessageEvent(): MatrixRawEvent {
  return {
    event_id: "$event-1:example.org",
    sender: "@alice:example.org",
    type: EventType.RoomMessage,
    origin_server_ts: 1,
    content: {
      msgtype: "m.text",
      body: "@bot hello from thread",
      "m.relates_to": {
        rel_type: RelationType.Thread,
        event_id: "$ThreadRoot:Example.Org",
      },
    },
  };
}

function createThreadRetryHarness(options?: {
  cfg?: CoreConfig;
  readSessionUpdatedAt?: (params: { storePath: string; sessionKey: string }) => number | undefined;
}) {
  const client = {
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
  } as unknown as MatrixClient;

  const mockReadSessionUpdatedAt = vi.fn(options?.readSessionUpdatedAt ?? (() => undefined));
  const mockRecordInboundSession = vi.fn().mockResolvedValue(undefined);
  const mockDispatchReplyFromConfig = vi.fn().mockResolvedValue({
    queuedFinal: true,
    counts: { final: 1 },
  });
  const mockFinalizeInboundContext = vi.fn((ctx) => ctx);
  const mockMarkDispatchIdle = vi.fn();
  const mockCreateReplyDispatcherWithTyping = vi.fn(() => ({
    dispatcher: {},
    replyOptions: {},
    markDispatchIdle: mockMarkDispatchIdle,
  }));

  const core = {
    channel: {
      pairing: {
        readAllowFromStore: vi.fn().mockResolvedValue([]),
        upsertPairingRequest: vi.fn(),
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "main",
          accountId: "default",
          sessionKey: "agent:main:matrix:channel:!room:example.org",
          mainSessionKey: "agent:main:matrix:main",
        })),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/matrix-sessions.json"),
        readSessionUpdatedAt: mockReadSessionUpdatedAt,
        recordInboundSession: mockRecordInboundSession,
      },
      commands: {
        shouldHandleTextCommands: vi.fn(() => false),
      },
      text: {
        hasControlCommand: vi.fn(() => false),
        resolveMarkdownTableMode: vi.fn(() => "code"),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => ({ template: "channel+name+time" })),
        formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
        finalizeInboundContext: mockFinalizeInboundContext,
        createReplyDispatcherWithTyping: mockCreateReplyDispatcherWithTyping,
        resolveHumanDelayConfig: vi.fn(() => undefined),
        dispatchReplyFromConfig: mockDispatchReplyFromConfig,
      },
      reactions: {
        shouldAckReaction: vi.fn(() => false),
      },
      mentions: {
        matchesMentionPatterns: vi.fn((text: string, regexes: RegExp[]) =>
          regexes.some((pattern) => pattern.test(text)),
        ),
      },
    },
    system: {
      enqueueSystemEvent: vi.fn(),
    },
  } as unknown as PluginRuntime;

  setMatrixRuntime(core);

  const runtime = {
    error: vi.fn(),
  };

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const logVerboseMessage = vi.fn();

  const handler = createMatrixRoomMessageHandler({
    client,
    core,
    cfg: options?.cfg ?? {},
    runtime,
    logger,
    logVerboseMessage,
    allowFrom: [],
    roomsConfig: undefined,
    mentionRegexes: [/@bot/i],
    groupPolicy: "open",
    replyToMode: "off",
    threadReplies: "inbound",
    dmEnabled: true,
    dmPolicy: "open",
    textLimit: 4000,
    mediaMaxBytes: 5 * 1024 * 1024,
    startupMs: 0,
    startupGraceMs: 0,
    directTracker: {
      isDirectMessage: vi.fn().mockResolvedValue(false),
    },
    getRoomInfo: vi.fn().mockResolvedValue({
      name: "Test Room",
      canonicalAlias: "#test:example.org",
      altAliases: [],
    }),
    getMemberDisplayName: vi.fn(async (_roomId: string, userId: string) => {
      if (userId === "@alice:example.org") {
        return "Alice";
      }
      return "Thread Starter";
    }),
  });

  return {
    client,
    handler,
    logVerboseMessage,
    mockDispatchReplyFromConfig,
    mockReadSessionUpdatedAt,
    mockRecordInboundSession,
  };
}
