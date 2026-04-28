import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { _resetThreadParentContextCachesForTest } from "../thread-parent-context.js";
import "./message-handler-mock-support.test-support.js";
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import {
  buildChannelActivity,
  channelConversationId,
  createMessageHandlerDeps,
} from "./message-handler.test-support.js";

const runtimeApiMockState = getRuntimeApiMockState();
const fetchChannelMessageMock = vi.hoisted(() => vi.fn());
const fetchThreadRepliesMock = vi.hoisted(() => vi.fn(async () => []));
const resolveTeamGroupIdMock = vi.hoisted(() => vi.fn(async () => "group-1"));

vi.mock("../graph-thread.js", () => {
  const stripHtmlFromTeamsMessage = (html: string) =>
    html
      .replace(/<at[^>]*>(.*?)<\/at>/gi, "@$1")
      .replace(/<[^>]*>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  return {
    stripHtmlFromTeamsMessage,
    resolveTeamGroupId: resolveTeamGroupIdMock,
    fetchChannelMessage: fetchChannelMessageMock,
    fetchThreadReplies: fetchThreadRepliesMock,
  };
});

describe("msteams thread parent context injection", () => {
  type MessageHandler = ReturnType<typeof createMSTeamsMessageHandler>;

  function findParentSystemEventCall(
    mock: ReturnType<typeof vi.fn>,
  ): [string, { sessionKey: string; contextKey?: string }] | undefined {
    const calls = mock.mock.calls as Array<[string, { sessionKey: string; contextKey?: string }]>;
    return calls.find(([text]) => text.startsWith("Replying to @"));
  }

  async function dispatchThreadReply(handler: MessageHandler, id: string) {
    await handler({
      activity: buildChannelActivity({ id, replyToId: "thread-root-123" }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<MessageHandler>[0]);
  }

  async function dispatchTwoThreadReplies(handler: MessageHandler) {
    await dispatchThreadReply(handler, "msg-reply-1");
    await dispatchThreadReply(handler, "msg-reply-2");
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
    const { deps, enqueueSystemEvent } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: buildChannelActivity({ id: "msg-reply-1", replyToId: "thread-root-123" }),
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
    const { deps } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await dispatchTwoThreadReplies(handler);

    // Parent message fetched exactly once across two replies thanks to LRU cache.
    expect(fetchChannelMessageMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-enqueue the same parent context within the same session", async () => {
    fetchChannelMessageMock.mockResolvedValue({
      id: "thread-root-123",
      from: { user: { displayName: "Alice" } },
      body: { content: "Original question", contentType: "text" },
    });
    const { deps, enqueueSystemEvent } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await dispatchTwoThreadReplies(handler);

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
    const { deps, enqueueSystemEvent } = createMessageHandlerDeps({
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
      activity: buildChannelActivity({
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
    const { deps, enqueueSystemEvent } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: buildChannelActivity({ id: "msg-reply-1", replyToId: "thread-root-123" }),
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
    const { deps, enqueueSystemEvent } = createMessageHandlerDeps({
      channels: { msteams: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: {
        ...buildChannelActivity(),
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
    const { deps, enqueueSystemEvent } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: buildChannelActivity({ id: "msg-root-1", replyToId: undefined }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(fetchChannelMessageMock).not.toHaveBeenCalled();
    expect(findParentSystemEventCall(enqueueSystemEvent)).toBeUndefined();
  });

  it("dispatches mention-only thread replies with thread context", async () => {
    fetchChannelMessageMock.mockResolvedValue({
      id: "thread-root-123",
      from: { user: { displayName: "Alice", id: "alice-id" } },
      body: { content: "Can someone investigate the latency spike?", contentType: "text" },
    });
    fetchThreadRepliesMock.mockResolvedValue([
      {
        id: "thread-reply-1",
        from: { user: { displayName: "Bob", id: "bob-id" } },
        body: { content: "The p95 is spiking again.", contentType: "text" },
      } as never,
    ]);
    cacheThreadMessage(channelConversationId, "thread-root-123", {
      messageId: "thread-root-123",
      from: "Alice",
      fromId: "alice-id",
      content: "Can someone investigate the latency spike?",
      timestamp: 1,
    });
    cacheThreadMessage(channelConversationId, "thread-root-123", {
      messageId: "thread-reply-1",
      from: "Bob",
      fromId: "bob-id",
      content: "The p95 is spiking again.",
      timestamp: 2,
    });
    runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mockResolvedValueOnce({
      queuedFinal: false,
      counts: {},
      capturedCtxPayload: undefined,
    });
    const { deps } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: buildChannelActivity({
        id: "msg-reply-mention-only",
        text: "<at>Bot</at>",
        replyToId: "thread-root-123",
      }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher).toHaveBeenCalledTimes(
      1,
    );
    expect(
      runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mock.calls[0]?.[0]
        ?.ctxPayload,
    ).toMatchObject({
      RawBody: "",
      WasMentioned: true,
      ReplyToId: "thread-root-123",
      BodyForAgent:
        "[Thread history]\nAlice: Can someone investigate the latency spike?\nBob: The p95 is spiking again.\n[/Thread history]\n\nThe user mentioned you in this thread without additional text. Use the thread context to infer what they want and reply in the thread.",
    });
  });

  it("still skips mention-only top-level channel posts", async () => {
    const { deps, enqueueSystemEvent } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: buildChannelActivity({
        id: "msg-root-mention-only",
        text: "<at>Bot</at>",
        replyToId: undefined,
      }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(fetchChannelMessageMock).not.toHaveBeenCalled();
    expect(runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("uses in-memory cache for thread context when Graph API fails", async () => {
    fetchChannelMessageMock.mockRejectedValue(new Error("403 Forbidden"));
    fetchThreadRepliesMock.mockRejectedValue(new Error("403 Forbidden"));
    runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mockResolvedValueOnce({
      queuedFinal: false,
      counts: {},
      capturedCtxPayload: undefined,
    });
    const { deps } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    // First: a non-mention message arrives in the thread (e.g. from another bot via RSC).
    await handler({
      activity: buildChannelActivity({
        id: "moltbot-msg-1",
        text: "这是Moltbot发的消息",
        replyToId: "thread-root-123",
        entities: [], // no bot mention
      }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    // Bot was not mentioned, so it should not dispatch a reply.
    expect(runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher).not.toHaveBeenCalled();

    // Now the user @mentions PM Chen in the same thread.
    await handler({
      activity: buildChannelActivity({
        id: "msg-mention-only",
        text: "<at>Bot</at>",
        replyToId: "thread-root-123",
      }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher).toHaveBeenCalledTimes(
      1,
    );
    const ctxPayload =
      runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mock.calls[0]?.[0]
        ?.ctxPayload;
    // Should use the "use thread context" instruction (not fallback) because cache has a message.
    expect((ctxPayload as { BodyForAgent?: string }).BodyForAgent).toContain(
      "Use the thread context to infer what they want",
    );
  });

  it("filters in-memory thread cache fallback by group allowlist", async () => {
    fetchChannelMessageMock.mockRejectedValue(new Error("403 Forbidden"));
    fetchThreadRepliesMock.mockRejectedValue(new Error("403 Forbidden"));
    runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mockResolvedValueOnce({
      queuedFinal: false,
      counts: {},
      capturedCtxPayload: undefined,
    });
    const { deps } = createMessageHandlerDeps({
      channels: {
        msteams: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["alice-aad"],
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

    cacheThreadMessage(channelConversationId, "thread-root-123", {
      messageId: "mallory-msg-1",
      from: "Mallory",
      fromId: "mallory-aad",
      content: "disallowed cached message",
      timestamp: Date.now(),
    });

    await handler({
      activity: buildChannelActivity({
        id: "msg-mention-only",
        text: "<at>Bot</at>",
        replyToId: "thread-root-123",
        from: { id: "alice-id", aadObjectId: "alice-aad", name: "Alice" },
      }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    const ctxPayload =
      runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mock.calls[0]?.[0]
        ?.ctxPayload;
    expect((ctxPayload as { BodyForAgent?: string }).BodyForAgent).not.toContain(
      "disallowed cached message",
    );
    expect((ctxPayload as { BodyForAgent?: string }).BodyForAgent).toContain(
      "no thread history was accessible",
    );
  });

  it("uses fallback text when mention-only but Graph fetch fails", async () => {
    fetchChannelMessageMock.mockRejectedValue(new Error("403 Forbidden"));
    fetchThreadRepliesMock.mockRejectedValue(new Error("403 Forbidden"));
    runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mockResolvedValueOnce({
      queuedFinal: false,
      counts: {},
      capturedCtxPayload: undefined,
    });
    const { deps } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: buildChannelActivity({
        id: "msg-reply-mention-only-noperm",
        text: "<at>Bot</at>",
        replyToId: "thread-root-123",
      }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher).toHaveBeenCalledTimes(
      1,
    );
    const ctxPayload =
      runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mock.calls[0]?.[0]
        ?.ctxPayload;
    expect(ctxPayload).toMatchObject({
      RawBody: "",
      WasMentioned: true,
      ReplyToId: "thread-root-123",
    });
    // Should use fallback text (no thread context), not the "use thread context" instruction.
    expect((ctxPayload as { BodyForAgent?: string }).BodyForAgent).toContain(
      "no thread history was accessible",
    );
    expect((ctxPayload as { BodyForAgent?: string }).BodyForAgent).not.toContain(
      "[Thread history]",
    );
  });
});
