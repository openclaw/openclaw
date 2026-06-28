// Googlechat tests cover monitor plugin behavior.
import { recordChannelBotPairLoopAndCheckSuppression } from "openclaw/plugin-sdk/channel-inbound";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";
import { testing } from "./monitor.js";
import type { GoogleChatEvent } from "./types.js";

const apiMocks = vi.hoisted(() => ({
  downloadGoogleChatMedia: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  applyGoogleChatInboundAccessPolicy: vi.fn(),
}));

vi.mock("./api.js", () => ({
  downloadGoogleChatMedia: apiMocks.downloadGoogleChatMedia,
  sendGoogleChatMessage: apiMocks.sendGoogleChatMessage,
}));

vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: accessMocks.applyGoogleChatInboundAccessPolicy,
}));

beforeEach(() => {
  apiMocks.downloadGoogleChatMedia.mockReset();
  apiMocks.sendGoogleChatMessage.mockReset();
  accessMocks.applyGoogleChatInboundAccessPolicy.mockReset();
});

function createInboundClassificationHarness() {
  const resolveAgentRoute = vi.fn(() => ({
    agentId: "agent-1",
    accountId: "work",
    sessionKey: "session-1",
  }));
  const buildContext = vi.fn((payload: unknown) => payload);
  const runTurn = vi.fn();
  const core = {
    logging: { shouldLogVerbose: () => false },
    channel: {
      routing: { resolveAgentRoute },
      session: {
        resolveStorePath: () => "/tmp/openclaw-googlechat-test",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: vi.fn(),
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
      },
      inbound: { buildContext, run: runTurn },
    },
  } as unknown as GoogleChatCoreRuntime;
  return { buildContext, core, resolveAgentRoute, runTurn };
}

describe("googlechat monitor bot loop protection", () => {
  it("maps accepted bot-authored messages to shared channel-turn facts", () => {
    expect(
      testing.resolveGoogleChatBotLoopProtection({
        allowBots: true,
        isBotSender: true,
        senderId: "users/other-bot",
        appUserId: "users/app-bot",
        accountId: "work",
        conversationId: "spaces/AAA",
        config: { maxEventsPerWindow: 3 },
        defaultsConfig: { maxEventsPerWindow: 20 },
        eventTime: "2026-03-22T00:00:00.000Z",
      }),
    ).toEqual({
      scopeId: "work",
      conversationId: "spaces/AAA",
      senderId: "users/other-bot",
      receiverId: "users/app-bot",
      config: { maxEventsPerWindow: 3 },
      defaultsConfig: { maxEventsPerWindow: 20 },
      defaultEnabled: true,
      nowMs: Date.parse("2026-03-22T00:00:00.000Z"),
    });
  });

  it("does not guard human messages or the app's own echo", () => {
    expect(
      testing.resolveGoogleChatBotLoopProtection({
        allowBots: true,
        isBotSender: false,
        senderId: "users/alice",
        appUserId: "users/app",
        accountId: "work",
        conversationId: "spaces/AAA",
      }),
    ).toBeUndefined();
    expect(
      testing.resolveGoogleChatBotLoopProtection({
        allowBots: true,
        isBotSender: true,
        senderId: "users/app",
        appUserId: "users/app",
        accountId: "work",
        conversationId: "spaces/AAA",
      }),
    ).toBeUndefined();
  });

  it("layers space bot loop overrides over account settings field-by-field", () => {
    expect(
      testing.resolveGoogleChatBotLoopProtectionConfig({
        accountConfig: { windowSeconds: 120, cooldownSeconds: 240 },
        groupConfig: { maxEventsPerWindow: 3 },
      }),
    ).toEqual({
      maxEventsPerWindow: 3,
      windowSeconds: 120,
      cooldownSeconds: 240,
    });
  });

  it("suppresses bot loops before creating typing messages", async () => {
    const eventTimeMs = Date.parse("2026-03-22T00:00:00.000Z");
    const accountId = `bot-loop-typing-${eventTimeMs}`;
    const conversationId = "spaces/LOOP";
    const senderId = "users/other-bot";
    const receiverId = "users/app";
    const runTurn = vi.fn();
    const core = {
      logging: { shouldLogVerbose: () => false },
      channel: {
        inbound: { run: runTurn },
      },
    } as unknown as GoogleChatCoreRuntime;
    const runtime = { error: vi.fn(), log: vi.fn() } satisfies GoogleChatRuntimeEnv;
    const account = {
      accountId,
      config: {
        allowBots: true,
        botUser: receiverId,
        botLoopProtection: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 },
        typingIndicator: "message",
      },
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      eventTime: "2026-03-22T00:00:00.001Z",
      space: { name: conversationId, type: "DM" },
      message: {
        name: "spaces/LOOP/messages/2",
        text: "loop",
        sender: { name: senderId, type: "BOT" },
      },
    } satisfies GoogleChatEvent;

    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });
    recordChannelBotPairLoopAndCheckSuppression({
      scopeId: accountId,
      conversationId,
      senderId,
      receiverId,
      config: account.config.botLoopProtection,
      defaultEnabled: true,
      nowMs: eventTimeMs,
    });

    await testing.processMessageWithPipeline({
      event,
      account,
      config: {},
      runtime,
      core,
      mediaMaxMb: 10,
    });

    expect(apiMocks.sendGoogleChatMessage).not.toHaveBeenCalled();
    expect(apiMocks.downloadGoogleChatMedia).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
  });
});

describe("googlechat monitor inbound space classification", () => {
  const cases = [
    { name: "legacy DM", space: { type: "DM" }, peerKind: "direct" },
    { name: "modern direct message", space: { spaceType: "DIRECT_MESSAGE" }, peerKind: "direct" },
    { name: "single-user bot DM", space: { singleUserBotDm: true }, peerKind: "direct" },
    { name: "modern space", space: { spaceType: "SPACE" }, peerKind: "group" },
    { name: "modern group chat", space: { spaceType: "GROUP_CHAT" }, peerKind: "group" },
    {
      name: "modern space over legacy DM",
      space: { type: "DM", spaceType: "SPACE" },
      peerKind: "group",
    },
  ] as const;

  it.each(cases)("$name uses the expected access and route branch", async ({ space, peerKind }) => {
    const { buildContext, core, resolveAgentRoute, runTurn } = createInboundClassificationHarness();
    const account = {
      accountId: "work",
      config: {},
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      space: { name: "spaces/CLASSIFY", ...space },
      message: {
        name: "spaces/CLASSIFY/messages/1",
        text: "hello",
        sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      },
    } satisfies GoogleChatEvent;

    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });

    await testing.processMessageWithPipeline({
      event,
      account,
      config: {},
      runtime: { error: vi.fn(), log: vi.fn() },
      core,
      mediaMaxMb: 10,
    });

    const isGroup = peerKind === "group";
    expect(accessMocks.applyGoogleChatInboundAccessPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ isGroup }),
    );
    expect(resolveAgentRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "googlechat",
      accountId: "work",
      peer: { kind: peerKind, id: "spaces/CLASSIFY" },
    });
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({ kind: isGroup ? "channel" : "direct" }),
        extra: expect.objectContaining({ ChatType: isGroup ? "channel" : "direct" }),
      }),
    );
    expect(runTurn).toHaveBeenCalledOnce();
  });
});

describe("googlechat monitor direct messages", () => {
  it("creates typing messages by default", async () => {
    const runTurn = vi.fn();
    const buildContext = vi.fn((payload: unknown) => payload);
    const core = {
      logging: { shouldLogVerbose: () => false },
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            accountId: "work",
            sessionKey: "session-1",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/openclaw-googlechat-test",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: vi.fn(),
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: { body: string }) => body,
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        },
        inbound: { buildContext, run: runTurn },
      },
    } as unknown as GoogleChatCoreRuntime;
    const runtime = { error: vi.fn(), log: vi.fn() } satisfies GoogleChatRuntimeEnv;
    const account = {
      accountId: "work",
      config: {},
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      eventTime: "2026-03-22T00:00:00.001Z",
      space: { name: "spaces/DM", type: "DM" },
      message: {
        name: "spaces/DM/messages/2",
        text: "hello",
        sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      },
    } satisfies GoogleChatEvent;

    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });

    await testing.processMessageWithPipeline({
      event,
      account,
      config: {},
      runtime,
      core,
      mediaMaxMb: 10,
    });

    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/DM",
      text: "_OpenClaw is typing..._",
      thread: undefined,
    });
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("omits thread metadata from DM reply context and typing messages by default", async () => {
    const runTurn = vi.fn();
    const buildContext = vi.fn((payload: unknown) => payload);
    const core = {
      logging: { shouldLogVerbose: () => false },
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            accountId: "work",
            sessionKey: "session-1",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/openclaw-googlechat-test",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: vi.fn(),
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: { body: string }) => body,
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        },
        inbound: { buildContext, run: runTurn },
      },
    } as unknown as GoogleChatCoreRuntime;
    const runtime = { error: vi.fn(), log: vi.fn() } satisfies GoogleChatRuntimeEnv;
    const account = {
      accountId: "work",
      config: {
        typingIndicator: "message",
      },
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      eventTime: "2026-03-22T00:00:00.001Z",
      space: { name: "spaces/DM", type: "DM" },
      message: {
        name: "spaces/DM/messages/2",
        text: "hello",
        thread: { name: "spaces/DM/threads/thread-1" },
        sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      },
    } satisfies GoogleChatEvent;

    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });
    apiMocks.sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/DM/messages/typing",
    });

    await testing.processMessageWithPipeline({
      event,
      account,
      config: {},
      runtime,
      core,
      mediaMaxMb: 10,
    });

    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        reply: {
          to: "googlechat:spaces/DM",
          originatingTo: "googlechat:spaces/DM",
          replyToId: undefined,
          replyToIdFull: undefined,
        },
      }),
    );
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/DM",
      text: "_OpenClaw is typing..._",
      thread: undefined,
    });
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("uses a thread-specific DM session while preserving original DM peer bindings", async () => {
    const runTurn = vi.fn();
    const buildContext = vi.fn((payload: unknown) => payload);
    const core = {
      logging: { shouldLogVerbose: () => false },
      channel: {
        routing: {
          resolveAgentRoute: vi.fn(resolveAgentRoute),
        },
        session: {
          resolveStorePath: () => "/tmp/openclaw-googlechat-test",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: vi.fn(),
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: { body: string }) => body,
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        },
        inbound: { buildContext, run: runTurn },
      },
    } as unknown as GoogleChatCoreRuntime;
    const runtime = { error: vi.fn(), log: vi.fn() } satisfies GoogleChatRuntimeEnv;
    const account = {
      accountId: "work",
      config: {
        threadSessions: true,
        typingIndicator: "message",
      },
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      eventTime: "2026-03-22T00:00:00.001Z",
      space: { name: "spaces/DM", type: "DM" },
      message: {
        name: "spaces/DM/messages/2",
        text: "hello",
        thread: { name: "spaces/DM/threads/thread-1" },
        sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      },
    } satisfies GoogleChatEvent;

    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });
    apiMocks.sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/DM/messages/typing",
    });

    await testing.processMessageWithPipeline({
      event,
      account,
      config: {
        agents: { list: [{ id: "agent-1" }, { id: "bound-agent" }] },
        bindings: [
          {
            agentId: "bound-agent",
            match: {
              channel: "googlechat",
              accountId: "work",
              peer: { kind: "direct", id: "spaces/DM" },
            },
          },
        ],
      },
      runtime,
      core,
      mediaMaxMb: 10,
    });

    expect(core.channel.routing.resolveAgentRoute).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        bindings: [
          {
            agentId: "bound-agent",
            match: {
              channel: "googlechat",
              accountId: "work",
              peer: { kind: "direct", id: "spaces/DM" },
            },
          },
        ],
        session: { dmScope: "per-channel-peer" },
      }),
      channel: "googlechat",
      accountId: "work",
      peer: {
        kind: "direct",
        id: "spaces/DM:thread:spaces/DM/threads/thread-1",
      },
      parentPeer: {
        kind: "direct",
        id: "spaces/DM",
      },
    });

    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        route: {
          agentId: "bound-agent",
          accountId: "work",
          routeSessionKey:
            "agent:bound-agent:googlechat:direct:spaces/dm:thread:spaces/dm/threads/thread-1",
        },
        reply: {
          to: "googlechat:spaces/DM",
          originatingTo: "googlechat:spaces/DM",
          replyToId: "spaces/DM/threads/thread-1",
          replyToIdFull: "spaces/DM/threads/thread-1",
        },
      }),
    );
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/DM",
      text: "_OpenClaw is typing..._",
      thread: "spaces/DM/threads/thread-1",
    });
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("drops invalid event timestamps from inbound runtime payloads", async () => {
    const runTurn = vi.fn();
    const buildContext = vi.fn((payload: unknown) => payload);
    const formatAgentEnvelope = vi.fn(({ body }: { body: string }) => body);
    const core = {
      logging: { shouldLogVerbose: () => false },
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            accountId: "work",
            sessionKey: "session-1",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/openclaw-googlechat-test",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: vi.fn(),
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope,
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        },
        inbound: { buildContext, run: runTurn },
      },
    } as unknown as GoogleChatCoreRuntime;
    const runtime = { error: vi.fn(), log: vi.fn() } satisfies GoogleChatRuntimeEnv;
    const account = {
      accountId: "work",
      config: {
        typingIndicator: "message",
      },
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      eventTime: "not-a-timestamp",
      space: { name: "spaces/DM", type: "DM" },
      message: {
        name: "spaces/DM/messages/2",
        text: "hello",
        sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      },
    } satisfies GoogleChatEvent;

    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });

    await testing.processMessageWithPipeline({
      event,
      account,
      config: {},
      runtime,
      core,
      mediaMaxMb: 10,
    });

    expect(formatAgentEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: undefined }),
    );
    expect(buildContext).toHaveBeenCalledWith(expect.objectContaining({ timestamp: undefined }));
    const runArg = runTurn.mock.calls[0]?.[0] as
      | { adapter?: { ingest?: () => { timestamp?: number } } }
      | undefined;
    expect(runArg?.adapter?.ingest?.().timestamp).toBeUndefined();
  });
});
