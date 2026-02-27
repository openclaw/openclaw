import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleFeishuReactionEvent,
  type FeishuReactionEvent,
  _resetMessageInfoCacheForTest,
} from "./reaction-events.js";
import { setFeishuRuntime } from "./runtime.js";

const { mockGetMessageFeishu, mockTryRecordMessagePersistent } = vi.hoisted(() => ({
  mockGetMessageFeishu: vi.fn(),
  mockTryRecordMessagePersistent: vi.fn(),
}));

vi.mock("./send.js", () => ({
  getMessageFeishu: mockGetMessageFeishu,
}));

vi.mock("./dedup.js", () => ({
  tryRecordMessagePersistent: mockTryRecordMessagePersistent,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: vi.fn(),
}));

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

  it("uses namespaced dedup key with reaction prefix", async () => {
    await handleFeishuReactionEvent({
      cfg: makeBaseCfg(),
      event: makeReactionEvent(),
      action: "added",
      runtime: createRuntimeEnv(),
    });

    expect(mockTryRecordMessagePersistent).toHaveBeenCalledWith(
      "reaction:added:om_test_msg:ou_user_123:THUMBSUP",
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

  it("dispatches system event with correct text format for added reaction", async () => {
    await handleFeishuReactionEvent({
      cfg: makeBaseCfg(),
      event: makeReactionEvent(),
      action: "added",
      runtime: createRuntimeEnv(),
    });

    expect(mockEnqueueSystemEvent).toHaveBeenCalledTimes(1);
    const [text, options] = mockEnqueueSystemEvent.mock.calls[0];
    expect(text).toContain("reaction added");
    expect(text).toContain(":THUMBSUP:");
    expect(text).toContain("ou_user_123");
    expect(text).toContain("om_test_msg");
    expect(text).toContain("hello world");
    expect(options.sessionKey).toBe("agent:main:feishu:group:oc_test_chat");
    expect(options.contextKey).toContain("feishu:reaction:added:");
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
});
