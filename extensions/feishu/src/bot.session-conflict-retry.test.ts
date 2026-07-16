// Feishu tests cover inbound dispatch retry/notice parity for reply session init conflicts.
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";
import { handleFeishuMessage } from "./bot.js";
import { setFeishuRuntime } from "./runtime.js";

const {
  mockCreateFeishuReplyDispatcher,
  mockSendMessageFeishu,
  mockCreateFeishuClient,
  mockResolveFeishuReasoningPreviewEnabled,
  mockMaybeCreateDynamicAgent,
} = vi.hoisted(() => ({
  mockCreateFeishuReplyDispatcher: vi.fn(() => ({
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
  mockSendMessageFeishu: vi.fn(),
  mockCreateFeishuClient: vi.fn(),
  mockResolveFeishuReasoningPreviewEnabled: vi.fn(() => false),
  mockMaybeCreateDynamicAgent: vi.fn(),
}));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher,
}));

vi.mock("./reasoning-preview.js", () => ({
  resolveFeishuReasoningPreviewEnabled: mockResolveFeishuReasoningPreviewEnabled,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: mockSendMessageFeishu,
  getMessageFeishu: vi.fn().mockResolvedValue(null),
  listFeishuThreadMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

vi.mock("./dynamic-agent.js", () => ({
  maybeCreateDynamicAgent: mockMaybeCreateDynamicAgent,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    resolveConfiguredBindingRoute: ({ route }: { route: ResolvedAgentRoute }) => ({
      bindingResolution: null,
      route,
    }),
    resolveRuntimeConversationBindingRoute: ({ route }: { route: ResolvedAgentRoute }) => ({
      bindingRecord: null,
      route,
    }),
    ensureConfiguredBindingRouteReady: async () => ({ ok: true }),
    getSessionBindingService: () => ({
      resolveByConversation: () => null,
      touch: () => {},
    }),
  };
});

afterAll(() => {
  vi.doUnmock("./reply-dispatcher.js");
  vi.doUnmock("./reasoning-preview.js");
  vi.doUnmock("./send.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./dynamic-agent.js");
  vi.doUnmock("openclaw/plugin-sdk/conversation-runtime");
  vi.resetModules();
});

const CONFLICT_ERROR = new Error(
  "reply session initialization conflicted for agent:main:feishu:direct:ou_sender_1",
);

const CFG = {
  session: { mainKey: "main", scope: "per-sender" },
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "open",
      allowFrom: ["*"],
      resolveSenderNames: false,
    },
  },
} as ClawdbotConfig;

let messageCounter = 0;

function createDmEvent(): FeishuMessageEvent {
  messageCounter += 1;
  return {
    sender: { sender_id: { open_id: "ou_sender_1" } },
    message: {
      message_id: `msg-conflict-${messageCounter}`,
      chat_id: "oc_dm",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
    },
  };
}

function createFeishuBotRuntime(
  inboundRun: PluginRuntime["channel"]["inbound"]["run"],
): PluginRuntime {
  return {
    config: {
      current: vi.fn(() => CFG),
    },
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(
          (): ResolvedAgentRoute => ({
            agentId: "main",
            channel: "feishu",
            accountId: "default",
            sessionKey: "agent:main:feishu:direct:ou_sender_1",
            mainSessionKey: "agent:main:main",
            lastRoutePolicy: "session",
            matchedBy: "default",
          }),
        ),
      },
      session: {
        readSessionUpdatedAt: vi.fn(() => undefined),
        resolveStorePath: vi.fn(() => "/tmp/feishu-sessions.json"),
        recordInboundSession: vi.fn(async () => undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
        finalizeInboundContext: vi.fn((ctx: Record<string, unknown>) => ctx),
        dispatchReplyFromConfig: vi
          .fn()
          .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } }),
        withReplyDispatcher: vi.fn(async ({ run }: { run: () => Promise<unknown> }) => await run()),
        settleReplyDispatcher: vi.fn(async () => undefined),
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => ["ou_sender_1"]),
        upsertPairingRequest: vi.fn(),
        buildPairingReply: vi.fn(),
      },
      inbound: {
        run: inboundRun,
      },
    },
  } as unknown as PluginRuntime;
}

async function dispatchDmMessage(inboundRun: PluginRuntime["channel"]["inbound"]["run"]) {
  setFeishuRuntime(createFeishuBotRuntime(inboundRun));
  const runtime = createRuntimeEnv();
  const settled = handleFeishuMessage({ cfg: CFG, event: createDmEvent(), runtime });
  // Drain the retry backoff ladder (1s + 2s + 4s) plus slack for other timers.
  for (let i = 0; i < 8; i += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  await settled;
  return runtime;
}

describe("feishu reply session init conflict retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockMaybeCreateDynamicAgent.mockImplementation(async ({ cfg }: { cfg: ClawdbotConfig }) => ({
      created: false,
      updatedCfg: cfg,
    }));
    mockSendMessageFeishu.mockResolvedValue({ messageId: "notice-msg", chatId: "oc_dm" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries dispatch after a reply session init conflict and recovers", async () => {
    const inboundRun = vi
      .fn()
      .mockRejectedValueOnce(CONFLICT_ERROR)
      .mockResolvedValueOnce({
        dispatched: true,
        dispatchResult: { queuedFinal: false, counts: { final: 1 } },
      });

    const runtime = await dispatchDmMessage(inboundRun);

    expect(inboundRun).toHaveBeenCalledTimes(2);
    expect(mockSendMessageFeishu).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("notifies the sender instead of dropping silently when the conflict persists", async () => {
    const inboundRun = vi.fn().mockRejectedValue(CONFLICT_ERROR);

    const runtime = await dispatchDmMessage(inboundRun);

    // Initial attempt plus the bounded retry ladder.
    expect(inboundRun).toHaveBeenCalledTimes(4);
    expect(mockSendMessageFeishu).toHaveBeenCalledTimes(1);
    const notice = mockSendMessageFeishu.mock.calls[0]?.[0] as {
      to?: string;
      text?: string;
      replyToMessageId?: string;
    };
    expect(notice.to).toBe("user:ou_sender_1");
    expect(notice.text).toContain("session stayed busy");
    // The loss notice must land as a reply to the dropped message, not detached.
    expect(notice.replyToMessageId).toMatch(/^msg-conflict-/);
    expect(
      (runtime.error as ReturnType<typeof vi.fn>).mock.calls.some((call) =>
        String(call[0]).includes("reply session init conflict"),
      ),
    ).toBe(true);
  });

  it("does not retry or notify for non-conflict dispatch failures", async () => {
    const inboundRun = vi.fn().mockRejectedValue(new Error("feishu api unavailable"));

    const runtime = await dispatchDmMessage(inboundRun);

    expect(inboundRun).toHaveBeenCalledTimes(1);
    expect(mockSendMessageFeishu).not.toHaveBeenCalled();
    expect(
      (runtime.error as ReturnType<typeof vi.fn>).mock.calls.some((call) =>
        String(call[0]).includes("failed to dispatch message"),
      ),
    ).toBe(true);
  });
});
