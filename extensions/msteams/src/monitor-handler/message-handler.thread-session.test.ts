import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../../runtime-api.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.js";
import { setMSTeamsRuntime } from "../runtime.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";

const runtimeApiMockState = vi.hoisted(() => ({
  dispatchReplyFromConfigWithSettledDispatcher: vi.fn(async (params: { ctxPayload: unknown }) => ({
    queuedFinal: false,
    counts: {},
    capturedCtxPayload: params.ctxPayload,
  })),
}));

vi.mock("../../runtime-api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../runtime-api.js")>("../../runtime-api.js");
  return {
    ...actual,
    dispatchReplyFromConfigWithSettledDispatcher:
      runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher,
  };
});

vi.mock("../graph-thread.js", async () => {
  const actual = await vi.importActual<typeof import("../graph-thread.js")>("../graph-thread.js");
  return {
    ...actual,
    resolveTeamGroupId: vi.fn(async () => "group-1"),
    fetchChannelMessage: vi.fn(async () => undefined),
    fetchThreadReplies: vi.fn(async () => []),
  };
});

vi.mock("../reply-dispatcher.js", () => ({
  createMSTeamsReplyDispatcher: () => ({
    dispatcher: {},
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  }),
}));

describe("msteams thread session isolation", () => {
  const channelConversationId = "19:general@thread.tacv2";

  function createDeps(cfg: OpenClawConfig) {
    const recordInboundSession = vi.fn(async (_params: { sessionKey: string }) => undefined);
    const resolveAgentRoute = vi.fn(({ peer }: { peer: { kind: string; id: string } }) => ({
      sessionKey: `agent:main:msteams:${peer.kind}:${peer.id}`,
      agentId: "main",
      accountId: "default",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "default" as const,
    }));

    setMSTeamsRuntime({
      logging: { shouldLogVerbose: () => false },
      system: { enqueueSystemEvent: vi.fn() },
      channel: {
        debounce: {
          resolveInboundDebounceMs: () => 0,
          createInboundDebouncer: <T>(params: {
            onFlush: (entries: T[]) => Promise<void>;
          }): { enqueue: (entry: T) => Promise<void> } => ({
            enqueue: async (entry: T) => {
              await params.onFlush([entry]);
            },
          }),
        },
        pairing: {
          readAllowFromStore: vi.fn(async () => []),
          upsertPairingRequest: vi.fn(async () => null),
        },
        text: {
          hasControlCommand: () => false,
          resolveTextChunkLimit: () => 4000,
        },
        routing: {
          resolveAgentRoute,
        },
        reply: {
          formatAgentEnvelope: ({ body }: { body: string }) => body,
          finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ctx,
        },
        session: {
          recordInboundSession,
          resolveStorePath: () => "/tmp/test-store",
        },
      },
    } as unknown as PluginRuntime);

    const deps: MSTeamsMessageHandlerDeps = {
      cfg,
      runtime: { error: vi.fn() } as unknown as RuntimeEnv,
      appId: "test-app",
      adapter: {} as MSTeamsMessageHandlerDeps["adapter"],
      tokenProvider: {
        getAccessToken: vi.fn(async () => "token"),
      },
      textLimit: 4000,
      mediaMaxBytes: 1024 * 1024,
      conversationStore: {
        get: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined),
      } as unknown as MSTeamsMessageHandlerDeps["conversationStore"],
      pollStore: {
        recordVote: vi.fn(async () => null),
      } as unknown as MSTeamsMessageHandlerDeps["pollStore"],
      log: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      } as unknown as MSTeamsMessageHandlerDeps["log"],
    };

    return {
      deps,
      recordInboundSession,
      resolveAgentRoute,
    };
  }

  function buildActivity(overrides: Record<string, unknown> = {}) {
    return {
      id: "msg-1",
      type: "message",
      text: "hello",
      from: {
        id: "user-id",
        aadObjectId: "user-aad",
        name: "Test User",
      },
      recipient: {
        id: "bot-id",
        name: "Bot",
      },
      conversation: {
        id: channelConversationId,
        conversationType: "channel",
      },
      channelData: { team: { id: "team-1" } },
      attachments: [],
      entities: [{ type: "mention", mentioned: { id: "bot-id" } }],
      ...overrides,
    };
  }

  it("appends thread suffix to session key for channel thread replies", async () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { groupPolicy: "open" } },
    } as OpenClawConfig;
    const { deps, recordInboundSession } = createDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    // Thread reply: has replyToId pointing to the thread root
    await handler({
      activity: buildActivity({ replyToId: "thread-root-123" }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const sessionKey = recordInboundSession.mock.calls[0]?.[0]?.sessionKey;
    expect(sessionKey).toContain("thread:");
    expect(sessionKey).toContain("thread-root-123");
  });

  it("does not append thread suffix for top-level channel messages", async () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { groupPolicy: "open" } },
    } as OpenClawConfig;
    const { deps, recordInboundSession } = createDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    // Top-level channel message: no replyToId
    await handler({
      activity: buildActivity({ replyToId: undefined }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const sessionKey = recordInboundSession.mock.calls[0]?.[0]?.sessionKey;
    expect(sessionKey).not.toContain("thread:");
    expect(sessionKey).toBe(`agent:main:msteams:channel:${channelConversationId}`);
  });

  it("produces different session keys for different threads in the same channel", async () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { groupPolicy: "open" } },
    } as OpenClawConfig;
    const { deps, recordInboundSession } = createDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: buildActivity({ id: "msg-1", replyToId: "thread-A" }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    await handler({
      activity: buildActivity({ id: "msg-2", replyToId: "thread-B" }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledTimes(2);
    const sessionKeyA = recordInboundSession.mock.calls[0]?.[0]?.sessionKey;
    const sessionKeyB = recordInboundSession.mock.calls[1]?.[0]?.sessionKey;
    expect(sessionKeyA).not.toBe(sessionKeyB);
    expect(sessionKeyA).toContain("thread-a"); // normalized lowercase
    expect(sessionKeyB).toContain("thread-b");
  });

  it("does not affect DM session keys", async () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const { deps, recordInboundSession } = createDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: {
        ...buildActivity(),
        conversation: {
          id: "a:dm-conversation",
          conversationType: "personal",
        },
        channelData: {},
        replyToId: "some-reply-id",
        entities: [],
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const sessionKey = recordInboundSession.mock.calls[0]?.[0]?.sessionKey;
    expect(sessionKey).not.toContain("thread:");
  });

  it("does not affect group chat session keys", async () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { groupPolicy: "open" } },
    } as OpenClawConfig;
    const { deps, recordInboundSession } = createDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: {
        ...buildActivity(),
        conversation: {
          id: "19:group-chat-id@unq.gbl.spaces",
          conversationType: "groupChat",
        },
        channelData: {},
        replyToId: "some-reply-id",
        entities: [{ type: "mention", mentioned: { id: "bot-id" } }],
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const sessionKey = recordInboundSession.mock.calls[0]?.[0]?.sessionKey;
    expect(sessionKey).not.toContain("thread:");
  });
});
