import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../../runtime-api.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.js";
import { setMSTeamsRuntime } from "../runtime.js";
import { _resetThreadParentContextCachesForTest } from "../thread-parent-context.js";
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

const fetchChannelMessageMock = vi.hoisted(() => vi.fn());
const fetchThreadRepliesMock = vi.hoisted(() => vi.fn(async () => []));
const resolveTeamGroupIdMock = vi.hoisted(() => vi.fn(async () => "group-1"));

vi.mock("../graph-thread.js", async () => {
  const actual = await vi.importActual<typeof import("../graph-thread.js")>("../graph-thread.js");
  return {
    ...actual,
    resolveTeamGroupId: resolveTeamGroupIdMock,
    fetchChannelMessage: fetchChannelMessageMock,
    fetchThreadReplies: fetchThreadRepliesMock,
  };
});

vi.mock("../reply-dispatcher.js", () => ({
  createMSTeamsReplyDispatcher: () => ({
    dispatcher: {},
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  }),
}));

describe("msteams thread parent context injection", () => {
  const channelConversationId = "19:general@thread.tacv2";

  function createDeps(cfg: OpenClawConfig) {
    const enqueueSystemEvent = vi.fn();
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
      system: { enqueueSystemEvent },
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
        routing: { resolveAgentRoute },
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

    return { deps, enqueueSystemEvent };
  }

  function channelActivity(overrides: Record<string, unknown> = {}) {
    return {
      id: "msg-1",
      type: "message",
      text: "hello",
      from: { id: "user-id", aadObjectId: "user-aad", name: "Test User" },
      recipient: { id: "bot-id", name: "Bot" },
      conversation: { id: channelConversationId, conversationType: "channel" },
      channelData: { team: { id: "team-1" } },
      attachments: [],
      entities: [{ type: "mention", mentioned: { id: "bot-id" } }],
      ...overrides,
    };
  }

  function findParentSystemEventCall(
    mock: ReturnType<typeof vi.fn>,
  ): [string, { sessionKey: string; contextKey?: string }] | undefined {
    const calls = mock.mock.calls as Array<[string, { sessionKey: string; contextKey?: string }]>;
    return calls.find(([text]) => text.startsWith("Replying to @"));
  }

  beforeEach(() => {
    _resetThreadParentContextCachesForTest();
    fetchChannelMessageMock.mockReset();
    fetchThreadRepliesMock.mockReset();
    fetchThreadRepliesMock.mockImplementation(async () => []);
    resolveTeamGroupIdMock.mockReset();
    resolveTeamGroupIdMock.mockImplementation(async () => "group-1");
    runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mockClear();
  });

  const cfg: OpenClawConfig = {
    channels: { msteams: { groupPolicy: "open" } },
  } as OpenClawConfig;

  it("enqueues a Replying to @sender system event on the first thread reply", async () => {
    fetchChannelMessageMock.mockResolvedValueOnce({
      id: "thread-root-123",
      from: { user: { displayName: "Alice", id: "alice-id" } },
      body: { content: "Can someone investigate the latency spike?", contentType: "text" },
    });
    const { deps, enqueueSystemEvent } = createDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: channelActivity({ id: "msg-reply-1", replyToId: "thread-root-123" }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    const parentCall = findParentSystemEventCall(enqueueSystemEvent);
    expect(parentCall).toBeDefined();
    expect(parentCall?.[0]).toBe("Replying to @Alice: Can someone investigate the latency spike?");
    expect(parentCall?.[1]?.contextKey).toContain("msteams:thread-parent:");
    expect(parentCall?.[1]?.contextKey).toContain("thread-root-123");
  });

  it("caches parent fetches across thread replies in the same session", async () => {
    fetchChannelMessageMock.mockResolvedValue({
      id: "thread-root-123",
      from: { user: { displayName: "Alice" } },
      body: { content: "Original question", contentType: "text" },
    });
    const { deps } = createDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: channelActivity({ id: "msg-reply-1", replyToId: "thread-root-123" }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    await handler({
      activity: channelActivity({ id: "msg-reply-2", replyToId: "thread-root-123" }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    // Parent message fetched exactly once across two replies thanks to LRU cache.
    expect(fetchChannelMessageMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-enqueue the same parent context within the same session", async () => {
    fetchChannelMessageMock.mockResolvedValue({
      id: "thread-root-123",
      from: { user: { displayName: "Alice" } },
      body: { content: "Original question", contentType: "text" },
    });
    const { deps, enqueueSystemEvent } = createDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: channelActivity({ id: "msg-reply-1", replyToId: "thread-root-123" }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    await handler({
      activity: channelActivity({ id: "msg-reply-2", replyToId: "thread-root-123" }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    const parentCalls = enqueueSystemEvent.mock.calls.filter(
      ([text]) => typeof text === "string" && text.startsWith("Replying to @"),
    );
    expect(parentCalls).toHaveLength(1);
  });

  it("does not enqueue parent context when allowlist visibility blocks the parent sender", async () => {
    fetchChannelMessageMock.mockResolvedValue({
      id: "thread-root-123",
      from: { user: { displayName: "Mallory", id: "mallory-aad" } },
      body: { content: "Blocked context", contentType: "text" },
    });
    const { deps, enqueueSystemEvent } = createDeps({
      channels: {
        msteams: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["alice-aad"],
          contextVisibility: "allowlist",
          teams: {
            "team-1": {
              channels: {
                [channelConversationId]: { requireMention: false },
              },
            },
          },
        },
      },
    } as OpenClawConfig);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: channelActivity({
        id: "msg-reply-1",
        replyToId: "thread-root-123",
        from: { id: "alice-id", aadObjectId: "alice-aad", name: "Alice" },
      }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(findParentSystemEventCall(enqueueSystemEvent)).toBeUndefined();
  });

  it("handles Graph failure gracefully without throwing or emitting a parent event", async () => {
    fetchChannelMessageMock.mockRejectedValueOnce(new Error("graph down"));
    const { deps, enqueueSystemEvent } = createDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: channelActivity({ id: "msg-reply-1", replyToId: "thread-root-123" }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    const parentCall = findParentSystemEventCall(enqueueSystemEvent);
    expect(parentCall).toBeUndefined();
    // Original inbound system event still fires (best-effort parent fetch does not block).
    expect(enqueueSystemEvent).toHaveBeenCalled();
  });

  it("does not fetch parent for DM replyToId", async () => {
    fetchChannelMessageMock.mockResolvedValue({
      id: "x",
      from: { user: { displayName: "Alice" } },
      body: { content: "should-not-happen", contentType: "text" },
    });
    const { deps, enqueueSystemEvent } = createDeps({
      channels: { msteams: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: {
        ...channelActivity(),
        conversation: { id: "a:dm-conversation", conversationType: "personal" },
        channelData: {},
        replyToId: "dm-parent",
        entities: [],
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(fetchChannelMessageMock).not.toHaveBeenCalled();
    expect(findParentSystemEventCall(enqueueSystemEvent)).toBeUndefined();
  });

  it("does not fetch parent for top-level channel messages without replyToId", async () => {
    fetchChannelMessageMock.mockResolvedValue({
      id: "x",
      from: { user: { displayName: "Alice" } },
      body: { content: "should-not-happen", contentType: "text" },
    });
    const { deps, enqueueSystemEvent } = createDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: channelActivity({ id: "msg-root-1", replyToId: undefined }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(fetchChannelMessageMock).not.toHaveBeenCalled();
    expect(findParentSystemEventCall(enqueueSystemEvent)).toBeUndefined();
  });
});
