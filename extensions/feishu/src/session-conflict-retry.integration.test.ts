// Feishu integration tests prove the session-init conflict retry in the actual
// handleFeishuMessage dispatch path — single-agent (non-broadcast group) and
// broadcast — with mocked downstream so the test exercises the real
// runFeishuDispatchWithSessionInitConflictRetry wiring, exhaustion notice, and
// active-versus-observer broadcast behavior.
import type { EnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";
import { handleFeishuMessage } from "./bot.js";
import { getFeishuRuntime, setFeishuRuntime } from "./runtime.js";

const CONFLICT_ERROR_MESSAGE =
  "reply session initialization conflicted for agent:codex:feishu:group:test-group";

const {
  mockCreateFeishuReplyDispatcher,
  mockCreateFeishuClient,
  mockResolveAgentRoute,
  mockSendMessageFeishu,
} = vi.hoisted(() => ({
  mockCreateFeishuReplyDispatcher: vi.fn((_p?: unknown) => ({
    dispatcher: {
      sendToolResult: vi.fn(),
      sendBlockReply: vi.fn(),
      sendFinalReply: vi.fn(),
      waitForIdle: vi.fn(),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    },
    replyOptions: {},
    markDispatchIdle: vi.fn(),
    ensureNoVisibleReplyFallback: vi.fn(),
  })),
  mockCreateFeishuClient: vi.fn(),
  mockResolveAgentRoute: vi.fn(),
  mockSendMessageFeishu: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher,
}));
vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));
vi.mock("./send.js", () => ({
  sendMessageFeishu: mockSendMessageFeishu,
  getMessageFeishu: vi.fn(),
  listFeishuThreadMessages: vi.fn(),
}));

const mockGetChatInfo = vi.fn();

function createRuntimeEnv() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  };
}

/** Factory for the shared runtime stub. `spy` is wired as inbound.run. */
function buildRuntime(spy: ReturnType<typeof vi.fn>): PluginRuntime {
  return {
    system: { enqueueSystemEvent: vi.fn() },
    channel: {
      routing: { resolveAgentRoute: (p: unknown) => mockResolveAgentRoute(p) },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/feishu-session-store.json"),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions:
          (() => ({})) as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
        formatAgentEnvelope: vi.fn((p: { body: string }) => p.body),
        finalizeInboundContext: vi.fn((ctx) => ({
          ...ctx,
          CommandAuthorized: false,
          CommandTurn: { kind: "normal" as const, source: "message" as const, authorized: false },
        })),
        dispatchReplyFromConfig: vi
          .fn()
          .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } }),
        withReplyDispatcher: (async ({ dispatcher, run, onSettled }: any) => {
          try {
            return await run();
          } finally {
            dispatcher.markComplete();
            await dispatcher.waitForIdle().finally(() => onSettled?.());
          }
        }) as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
      },
      media: {
        saveMediaBuffer: vi
          .fn()
          .mockResolvedValue({ path: "/tmp/test.mp4", contentType: "video/mp4" }),
      },
      inbound: { run: spy },
      pairing: {
        readAllowFromStore: vi.fn().mockResolvedValue([]),
        upsertPairingRequest: vi.fn().mockResolvedValue({ code: "TEST", created: false }),
        buildPairingReply: vi.fn(() => "Pairing response"),
      },
    },
    media: { detectMime: vi.fn(async () => "application/octet-stream") },
  } as unknown as PluginRuntime;
}

// ─── Single-agent dispatch (non-broadcast group) ─────────────────────────

describe("single-agent dispatch (group, no broadcast)", () => {
  const inboundRunSpy = vi.fn();

  afterAll(() => {
    vi.doUnmock("./reply-dispatcher.js");
    vi.doUnmock("./client.js");
    vi.doUnmock("./send.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetChatInfo.mockReset();
    inboundRunSpy.mockReset();
    mockCreateFeishuClient.mockReturnValue({
      contact: { user: { get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }) } },
      im: {
        chat: { get: mockGetChatInfo.mockResolvedValue({ code: 0, data: { name: "Test Group" } }) },
      },
    });
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: {
        sendToolResult: vi.fn(),
        sendBlockReply: vi.fn(),
        sendFinalReply: vi.fn(),
        waitForIdle: vi.fn(),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        markComplete: vi.fn(),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      ensureNoVisibleReplyFallback: vi.fn(),
    });
    mockResolveAgentRoute.mockReturnValue({
      agentId: "codex",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:codex:feishu:group:test-group",
      mainSessionKey: "agent:codex:main",
      lastRoutePolicy: "session",
      matchedBy: "config",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function run(msgId: string, text: string): Promise<void> {
    setFeishuRuntime(buildRuntime(inboundRunSpy));
    const cfg: ClawdbotConfig = {
      agents: { list: [{ id: "codex" }] },
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groups: { "test-group": { requireMention: true } },
        },
      },
    };
    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou_sender" } },
      message: {
        message_id: msgId,
        chat_id: "test-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text }),
        mentions: [
          { key: "@_user_1", id: { open_id: "bot-open-id" }, name: "Bot", tenant_key: "" },
        ],
      },
    };
    return handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });
  }

  it("succeeds immediately when no conflict", async () => {
    inboundRunSpy.mockResolvedValue({
      admission: { kind: "dispatch" },
      dispatched: true,
      dispatchResult: { queuedFinal: false, counts: { final: 1 } },
    });

    await run("msg-no-conflict", "hello");

    expect(inboundRunSpy).toHaveBeenCalledTimes(1);
    expect(mockSendMessageFeishu).not.toHaveBeenCalled();
  });

  it("retries on conflict and succeeds on second attempt", async () => {
    inboundRunSpy
      .mockImplementationOnce(async () => {
        throw new Error(CONFLICT_ERROR_MESSAGE);
      })
      .mockResolvedValue({
        admission: { kind: "dispatch" },
        dispatched: true,
        dispatchResult: { queuedFinal: false, counts: { final: 1 } },
      });

    const p = run("msg-retry", "hello");
    await vi.advanceTimersByTimeAsync(1_000);
    await p;

    expect(inboundRunSpy).toHaveBeenCalledTimes(2);
    expect(mockSendMessageFeishu).not.toHaveBeenCalled();
  });

  it("sends user notice after exhausting 1s/2s/4s retries", async () => {
    inboundRunSpy.mockRejectedValue(new Error(CONFLICT_ERROR_MESSAGE));

    const p = run("msg-exhaust", "hello");
    await vi.advanceTimersByTimeAsync(7_000);
    await p;

    // Initial + 3 retries = 4 calls, then user notice
    expect(inboundRunSpy).toHaveBeenCalledTimes(4);
    expect(mockSendMessageFeishu).toHaveBeenCalledTimes(1);
    expect(mockSendMessageFeishu.mock.calls[0][0].text).toBe(
      "⚠️ Couldn't process this message because the session stayed busy. Please try again in a moment.",
    );
  });

  it("does NOT retry non-conflict errors", async () => {
    inboundRunSpy.mockRejectedValue(new Error("feishu api unavailable"));

    await run("msg-nonconflict", "hello");

    // Error propagates to handleFeishuMessage's outer catch; logged, not retried
    expect(inboundRunSpy).toHaveBeenCalledTimes(1);
    expect(mockSendMessageFeishu).not.toHaveBeenCalled();
  });

  it("retries cause-nested conflict errors", async () => {
    inboundRunSpy
      .mockImplementationOnce(async () => {
        const inner = new Error(CONFLICT_ERROR_MESSAGE);
        throw new Error("wrapper", { cause: { error: inner } });
      })
      .mockResolvedValue({
        admission: { kind: "dispatch" },
        dispatched: true,
        dispatchResult: { queuedFinal: false, counts: { final: 1 } },
      });

    const p = run("msg-nested", "hello");
    await vi.advanceTimersByTimeAsync(1_000);
    await p;

    expect(inboundRunSpy).toHaveBeenCalledTimes(2);
    expect(mockSendMessageFeishu).not.toHaveBeenCalled();
  });
});

// ─── Broadcast dispatch ───────────────────────────────────────────────────

describe("broadcast dispatch", () => {
  const inboundRunSpy = vi.fn();

  afterAll(() => {
    vi.doUnmock("./reply-dispatcher.js");
    vi.doUnmock("./client.js");
    vi.doUnmock("./send.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetChatInfo.mockReset();
    inboundRunSpy.mockReset();
    mockCreateFeishuClient.mockReturnValue({
      contact: { user: { get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }) } },
      im: {
        chat: {
          get: mockGetChatInfo.mockResolvedValue({ code: 0, data: { name: "Broadcast Team" } }),
        },
      },
    });
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcher: {
        sendToolResult: vi.fn(),
        sendBlockReply: vi.fn(),
        sendFinalReply: vi.fn(),
        waitForIdle: vi.fn(),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        markComplete: vi.fn(),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      ensureNoVisibleReplyFallback: vi.fn(),
    });
    mockResolveAgentRoute
      .mockReset()
      .mockReturnValueOnce({
        agentId: "codex",
        channel: "feishu",
        accountId: "default",
        sessionKey: "agent:codex:feishu:group:oc-broadcast-group",
        mainSessionKey: "agent:codex:main",
        lastRoutePolicy: "session",
        matchedBy: "config",
      })
      .mockReturnValueOnce({
        agentId: "susan",
        channel: "feishu",
        accountId: "default",
        sessionKey: "agent:susan:feishu:group:oc-broadcast-group",
        mainSessionKey: "agent:susan:main",
        lastRoutePolicy: "session",
        matchedBy: "config",
      });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function run(msgId: string, text: string): Promise<void> {
    setFeishuRuntime(buildRuntime(inboundRunSpy));
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["codex", "susan"] },
      agents: { list: [{ id: "codex" }, { id: "susan" }] },
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groups: { "oc-broadcast-group": { requireMention: true } },
        },
      },
    };
    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: msgId,
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text }),
        mentions: [
          { key: "@_user_1", id: { open_id: "bot-open-id" }, name: "Bot", tenant_key: "" },
        ],
      },
    };
    return handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });
  }

  it("sends notice only for the active agent when its retries exhaust", async () => {
    // In parallel broadcast both agents start concurrently. codex (active)
    // must exhaust (4 failures) while susan (observer) succeeds immediately.
    // Mock queue: call 1 = codex conflict, call 2 = susan success,
    // calls 3-5 = codex retries (all conflict).
    inboundRunSpy
      .mockRejectedValueOnce(new Error(CONFLICT_ERROR_MESSAGE))
      .mockResolvedValueOnce({
        admission: { kind: "dispatch" },
        dispatched: true,
        dispatchResult: { queuedFinal: false, counts: { final: 1 } },
      })
      .mockRejectedValueOnce(new Error(CONFLICT_ERROR_MESSAGE))
      .mockRejectedValueOnce(new Error(CONFLICT_ERROR_MESSAGE))
      .mockRejectedValueOnce(new Error(CONFLICT_ERROR_MESSAGE));

    const p = run("bc-exhaust", "hello @bot");
    await vi.advanceTimersByTimeAsync(7_000);
    await p;

    // codex: 4 calls (1+3 retries), susan: 1 call = 5
    expect(inboundRunSpy).toHaveBeenCalledTimes(5);
    // Only active agent (codex) triggers notice
    expect(mockSendMessageFeishu).toHaveBeenCalledTimes(1);
    expect(mockSendMessageFeishu.mock.calls[0][0].text).toBe(
      "⚠️ Couldn't process this message because the session stayed busy. Please try again in a moment.",
    );
  });

  it("does NOT send notice for observer agent exhaustion", async () => {
    inboundRunSpy.mockRejectedValue(new Error(CONFLICT_ERROR_MESSAGE));

    const p = run("bc-observer", "hello @bot");
    await vi.advanceTimersByTimeAsync(7_000);
    await p;

    // Both agents exhaust: 4 + 4 = 8 calls
    expect(inboundRunSpy).toHaveBeenCalledTimes(8);
    // Only active agent (first = codex) triggers notice
    expect(mockSendMessageFeishu).toHaveBeenCalledTimes(1);
  });

  it("recovers per-agent: codex retries once, susan succeeds immediately", async () => {
    // First call (codex) throws conflict, subsequent calls succeed
    inboundRunSpy
      .mockImplementationOnce(async () => {
        throw new Error(CONFLICT_ERROR_MESSAGE);
      })
      .mockResolvedValue({
        admission: { kind: "dispatch" },
        dispatched: true,
        dispatchResult: { queuedFinal: false, counts: { final: 1 } },
      });

    const p = run("bc-recover", "hello @bot");
    await vi.advanceTimersByTimeAsync(1_000);
    await p;

    // codex: 2 calls, susan: 1 call = 3
    expect(inboundRunSpy).toHaveBeenCalledTimes(3);
    // No notice — codex recovered on retry
    expect(mockSendMessageFeishu).not.toHaveBeenCalled();
  });
});
