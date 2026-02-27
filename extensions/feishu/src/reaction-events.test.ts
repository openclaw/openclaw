import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleFeishuReactionEvent,
  type FeishuReactionEvent,
  _resetMessageInfoCacheForTest,
} from "./reaction-events.js";
import { setFeishuRuntime } from "./runtime.js";

const {
  mockGetMessageFeishu,
  mockTryRecordMessagePersistent,
  mockCreateFeishuReplyDispatcher,
  mockReadAllowFromStore,
} = vi.hoisted(() => ({
  mockGetMessageFeishu: vi.fn(),
  mockTryRecordMessagePersistent: vi.fn(),
  mockCreateFeishuReplyDispatcher: vi.fn(() => ({
    dispatcher: vi.fn(),
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  })),
  mockReadAllowFromStore: vi.fn((): Promise<string[]> => Promise.resolve([])),
}));

vi.mock("./send.js", () => ({
  getMessageFeishu: mockGetMessageFeishu,
}));

vi.mock("./dedup.js", () => ({
  tryRecordMessagePersistent: mockTryRecordMessagePersistent,
}));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createScopedPairingAccess: vi.fn(() => ({
      readAllowFromStore: mockReadAllowFromStore,
    })),
  };
});

function createRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  } as RuntimeEnv;
}

function makeReactionEvent(overrides: Partial<FeishuReactionEvent> = {}): FeishuReactionEvent {
  return {
    message_id: "om_test_msg",
    reaction_type: { emoji_type: "THUMBSUP" },
    operator_type: "user",
    user_id: { open_id: "ou_user_123" },
    ...overrides,
  };
}

function makeBaseCfg(overrides: Partial<ClawdbotConfig> = {}): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        groupPolicy: "open",
      },
    },
    ...overrides,
  } as ClawdbotConfig;
}

describe("handleFeishuReactionEvent", () => {
  const mockEnqueueSystemEvent = vi.fn();
  const mockFinalizeInboundContext = vi.fn((ctx: unknown) => ctx);
  const mockDispatchReplyFromConfig = vi
    .fn()
    .mockResolvedValue({ queuedFinal: false, counts: { final: 0 } });
  const mockWithReplyDispatcher = vi.fn(
    async ({ run, onSettled }: { run: () => Promise<unknown>; onSettled?: () => void }) => {
      try {
        return await run();
      } finally {
        onSettled?.();
      }
    },
  );
  const mockResolveAgentRoute = vi.fn(() => ({
    agentId: "main",
    accountId: "default",
    sessionKey: "agent:main:feishu:group:oc_test_chat",
    matchedBy: "default",
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    _resetMessageInfoCacheForTest();

    // Default: dedup passes (new event)
    mockTryRecordMessagePersistent.mockResolvedValue(true);

    mockGetMessageFeishu.mockResolvedValue({
      messageId: "om_test_msg",
      chatId: "oc_test_chat",
      chatType: "group",
      content: "hello world",
      contentType: "text",
    });

    setFeishuRuntime({
      system: {
        enqueueSystemEvent: mockEnqueueSystemEvent,
      },
      channel: {
        routing: {
          resolveAgentRoute: mockResolveAgentRoute,
        },
        reply: {
          finalizeInboundContext: mockFinalizeInboundContext,
          dispatchReplyFromConfig: mockDispatchReplyFromConfig,
          withReplyDispatcher: mockWithReplyDispatcher,
        },
      },
    } as unknown as PluginRuntime);
  });

  it("filters bot's own reactions by operator_type=app", async () => {
    const event = makeReactionEvent({ operator_type: "app" });
    await handleFeishuReactionEvent({
      cfg: makeBaseCfg(),
      event,
      action: "added",
      runtime: createRuntimeEnv(),
    });
    expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
    expect(mockTryRecordMessagePersistent).not.toHaveBeenCalled();
  });

  it("filters bot's own reactions by matching botOpenId", async () => {
    const event = makeReactionEvent({
      operator_type: "user",
      user_id: { open_id: "ou_bot_self" },
    });
    await handleFeishuReactionEvent({
      cfg: makeBaseCfg(),
      event,
      action: "added",
      botOpenId: "ou_bot_self",
      runtime: createRuntimeEnv(),
    });
    expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
    expect(mockTryRecordMessagePersistent).not.toHaveBeenCalled();
  });

  it("skips duplicate reaction events", async () => {
    mockTryRecordMessagePersistent.mockResolvedValue(false);

    await handleFeishuReactionEvent({
      cfg: makeBaseCfg(),
      event: makeReactionEvent(),
      action: "added",
      runtime: createRuntimeEnv(),
    });

    expect(mockTryRecordMessagePersistent).toHaveBeenCalled();
    expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("includes action_time in dedup key for add/remove/add cycles", async () => {
    const event = makeReactionEvent({ action_time: "1700000001" });
    await handleFeishuReactionEvent({
      cfg: makeBaseCfg(),
      event,
      action: "added",
      runtime: createRuntimeEnv(),
    });

    expect(mockTryRecordMessagePersistent).toHaveBeenCalledWith(
      "reaction:added:om_test_msg:ou_user_123:THUMBSUP:1700000001",
      expect.any(String),
      expect.anything(),
    );
  });

  it("handles message fetch failure gracefully", async () => {
    mockGetMessageFeishu.mockRejectedValueOnce(new Error("API error"));
    const runtime = createRuntimeEnv();

    await handleFeishuReactionEvent({
      cfg: makeBaseCfg(),
      event: makeReactionEvent(),
      action: "added",
      runtime,
    });

    expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to fetch message for reaction"),
    );
  });

  it("handles null message info gracefully", async () => {
    mockGetMessageFeishu.mockResolvedValueOnce(null);
    const runtime = createRuntimeEnv();

    await handleFeishuReactionEvent({
      cfg: makeBaseCfg(),
      event: makeReactionEvent(),
      action: "added",
      runtime,
    });

    expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("cannot resolve message"));
  });

  it("respects group policy — disabled groups are blocked", async () => {
    const cfg = makeBaseCfg({
      channels: {
        feishu: { groupPolicy: "disabled" },
      },
    } as Partial<ClawdbotConfig>);

    await handleFeishuReactionEvent({
      cfg,
      event: makeReactionEvent(),
      action: "added",
      runtime: createRuntimeEnv(),
    });

    expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("enqueues system event and dispatches to agent for added reaction", async () => {
    await handleFeishuReactionEvent({
      cfg: makeBaseCfg(),
      event: makeReactionEvent(),
      action: "added",
      runtime: createRuntimeEnv(),
    });

    // System event is enqueued
    expect(mockEnqueueSystemEvent).toHaveBeenCalledTimes(1);
    const [text, options] = mockEnqueueSystemEvent.mock.calls[0];
    expect(text).toContain("reaction added");
    expect(text).toContain(":THUMBSUP:");
    expect(text).toContain("ou_user_123");
    expect(text).toContain("om_test_msg");
    expect(text).toContain("hello world");
    expect(options.sessionKey).toBe("agent:main:feishu:group:oc_test_chat");
    expect(options.contextKey).toContain("feishu:reaction:added:");

    // Agent dispatch is triggered
    expect(mockWithReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("dispatches system event for removed reaction", async () => {
    await handleFeishuReactionEvent({
      cfg: makeBaseCfg(),
      event: makeReactionEvent(),
      action: "removed",
      runtime: createRuntimeEnv(),
    });

    expect(mockEnqueueSystemEvent).toHaveBeenCalledTimes(1);
    const [text] = mockEnqueueSystemEvent.mock.calls[0];
    expect(text).toContain("reaction removed");
  });

  it("caches message info to avoid repeated API calls", async () => {
    const cfg = makeBaseCfg();
    const runtime = createRuntimeEnv();

    // First reaction on a message
    const event1 = makeReactionEvent({ user_id: { open_id: "ou_user_a" } });
    await handleFeishuReactionEvent({ cfg, event: event1, action: "added", runtime });

    // Second reaction on the same message from a different user
    const event2 = makeReactionEvent({ user_id: { open_id: "ou_user_b" } });
    await handleFeishuReactionEvent({ cfg, event: event2, action: "added", runtime });

    // getMessageFeishu should only be called once due to caching
    expect(mockGetMessageFeishu).toHaveBeenCalledTimes(1);
    expect(mockEnqueueSystemEvent).toHaveBeenCalledTimes(2);
  });

  it("resolves agent route with group peer context", async () => {
    await handleFeishuReactionEvent({
      cfg: makeBaseCfg(),
      event: makeReactionEvent(),
      action: "added",
      runtime: createRuntimeEnv(),
    });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "feishu",
        peer: { kind: "group", id: "oc_test_chat" },
      }),
    );
  });

  it("blocks DM reaction from unauthorized sender when dmPolicy is pairing", async () => {
    mockGetMessageFeishu.mockResolvedValue({
      messageId: "om_dm_msg",
      chatId: "oc_dm_chat",
      chatType: "p2p",
      content: "hi",
      contentType: "text",
    });

    const cfg = makeBaseCfg({
      channels: {
        feishu: { dmPolicy: "pairing", allowFrom: ["ou_allowed_user"] },
      },
    } as Partial<ClawdbotConfig>);

    const runtime = createRuntimeEnv();
    await handleFeishuReactionEvent({
      cfg,
      event: makeReactionEvent({ user_id: { open_id: "ou_stranger" } }),
      action: "added",
      runtime,
    });

    expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("unauthorized DM sender"));
  });

  it("allows DM reaction when dmPolicy is open", async () => {
    mockGetMessageFeishu.mockResolvedValue({
      messageId: "om_dm_msg",
      chatId: "oc_dm_chat",
      chatType: "p2p",
      content: "hi",
      contentType: "text",
    });

    const cfg = makeBaseCfg({
      channels: { feishu: { dmPolicy: "open" } },
    } as Partial<ClawdbotConfig>);

    await handleFeishuReactionEvent({
      cfg,
      event: makeReactionEvent(),
      action: "added",
      runtime: createRuntimeEnv(),
    });

    expect(mockEnqueueSystemEvent).toHaveBeenCalledTimes(1);
  });

  it("allows DM reaction from paired user when dmPolicy is pairing", async () => {
    mockGetMessageFeishu.mockResolvedValue({
      messageId: "om_dm_msg",
      chatId: "oc_dm_chat",
      chatType: "p2p",
      content: "hi",
      contentType: "text",
    });

    const cfg = makeBaseCfg({
      channels: { feishu: { dmPolicy: "pairing" } },
    } as Partial<ClawdbotConfig>);

    // Pairing store returns this user as approved
    mockReadAllowFromStore.mockResolvedValueOnce(["ou_paired_user"]);

    await handleFeishuReactionEvent({
      cfg,
      event: makeReactionEvent({ user_id: { open_id: "ou_paired_user" } }),
      action: "added",
      runtime: createRuntimeEnv(),
    });

    expect(mockEnqueueSystemEvent).toHaveBeenCalledTimes(1);
  });

  it("does not read pairing store when dmPolicy is allowlist", async () => {
    mockGetMessageFeishu.mockResolvedValue({
      messageId: "om_dm_msg",
      chatId: "oc_dm_chat",
      chatType: "p2p",
      content: "hi",
      contentType: "text",
    });

    const cfg = makeBaseCfg({
      channels: { feishu: { dmPolicy: "allowlist", allowFrom: ["ou_allowed"] } },
    } as Partial<ClawdbotConfig>);

    await handleFeishuReactionEvent({
      cfg,
      event: makeReactionEvent({ user_id: { open_id: "ou_stranger" } }),
      action: "added",
      runtime: createRuntimeEnv(),
    });

    expect(mockReadAllowFromStore).not.toHaveBeenCalled();
    expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("matches sender by user_id in group sender allowlist", async () => {
    mockGetMessageFeishu.mockResolvedValue({
      messageId: "om_test_msg",
      chatId: "oc_test_chat",
      chatType: "group",
      content: "hello",
      contentType: "text",
    });

    const cfg = makeBaseCfg({
      channels: {
        feishu: {
          groupPolicy: "open",
          groups: {
            oc_test_chat: { allowFrom: ["uid_allowed"] },
          },
        },
      },
    } as Partial<ClawdbotConfig>);

    // open_id won't match, but user_id should
    const event = makeReactionEvent({
      user_id: { open_id: "ou_unknown", user_id: "uid_allowed" },
    });

    await handleFeishuReactionEvent({
      cfg,
      event,
      action: "added",
      runtime: createRuntimeEnv(),
    });

    expect(mockEnqueueSystemEvent).toHaveBeenCalledTimes(1);
  });

  it("skips event when user_id is missing (deleted event edge case)", async () => {
    const runtime = createRuntimeEnv();
    await handleFeishuReactionEvent({
      cfg: makeBaseCfg(),
      event: { message_id: "om_test_msg", reaction_type: { emoji_type: "THUMBSUP" } },
      action: "removed",
      runtime,
    });

    // Should not throw — handles missing user_id gracefully
    expect(mockEnqueueSystemEvent).toHaveBeenCalledTimes(1);
  });

  it("skips event when message_id or emoji is missing", async () => {
    const runtime = createRuntimeEnv();
    await handleFeishuReactionEvent({
      cfg: makeBaseCfg(),
      event: { reaction_type: { emoji_type: "THUMBSUP" } },
      action: "added",
      runtime,
    });
    expect(mockTryRecordMessagePersistent).not.toHaveBeenCalled();

    await handleFeishuReactionEvent({
      cfg: makeBaseCfg(),
      event: { message_id: "om_test_msg" },
      action: "added",
      runtime,
    });
    expect(mockTryRecordMessagePersistent).not.toHaveBeenCalled();
  });

  it("routes topic reactions to topic-scoped peer when topicSessionMode is enabled", async () => {
    mockGetMessageFeishu.mockResolvedValue({
      messageId: "om_topic_msg",
      chatId: "oc_test_chat",
      chatType: "group",
      content: "topic message",
      contentType: "text",
      rootId: "om_root_123",
    });

    const cfg = makeBaseCfg({
      channels: {
        feishu: {
          groupPolicy: "open",
          topicSessionMode: "enabled",
        },
      },
    } as Partial<ClawdbotConfig>);

    await handleFeishuReactionEvent({
      cfg,
      event: makeReactionEvent(),
      action: "added",
      runtime: createRuntimeEnv(),
    });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc_test_chat:topic:om_root_123" },
        parentPeer: { kind: "group", id: "oc_test_chat" },
      }),
    );
  });

  it("routes non-topic reactions without parentPeer", async () => {
    await handleFeishuReactionEvent({
      cfg: makeBaseCfg(),
      event: makeReactionEvent(),
      action: "added",
      runtime: createRuntimeEnv(),
    });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc_test_chat" },
        parentPeer: null,
      }),
    );
  });
});
