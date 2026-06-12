import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { monitorSingleAccount } from "./monitor.account.js";
import {
  createFeishuVcMeetingInvitedHandler,
  resolveVcMeetingInvitedTurn,
} from "./monitor.vc-meeting-invited-handler.js";
import type { ResolvedFeishuAccount } from "./types.js";

const handleFeishuMessageMock = vi.hoisted(() => vi.fn(async (_params?: unknown) => {}));
const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));
const createFeishuThreadBindingManagerMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));
const dedupMocks = vi.hoisted(() => ({
  warmupDedupFromPluginState: vi.fn(async () => 0),
  hasProcessedFeishuMessage: vi.fn(async () => false),
  recordProcessedFeishuMessage: vi.fn(async () => true),
}));

let handlers: Record<string, (data: unknown) => Promise<void>> = {};

vi.mock("./bot.js", async () => {
  const actual = await vi.importActual<typeof import("./bot.js")>("./bot.js");
  return {
    ...actual,
    handleFeishuMessage: handleFeishuMessageMock,
  };
});

vi.mock("./client.js", () => ({
  createEventDispatcher: createEventDispatcherMock,
}));

vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));

vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: createFeishuThreadBindingManagerMock,
}));

vi.mock("./dedup.js", async () => {
  const actual = await vi.importActual<typeof import("./dedup.js")>("./dedup.js");
  return {
    ...actual,
    warmupDedupFromPluginState: dedupMocks.warmupDedupFromPluginState,
    hasProcessedFeishuMessage: dedupMocks.hasProcessedFeishuMessage,
    recordProcessedFeishuMessage: dedupMocks.recordProcessedFeishuMessage,
  };
});

function buildConfig(overrides?: Partial<ClawdbotConfig>): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        dmPolicy: "open",
        allowFrom: ["*"],
      },
    },
    ...overrides,
  } as ClawdbotConfig;
}

function buildAccount(): ResolvedFeishuAccount {
  return {
    accountId: "default",
    selectionSource: "explicit",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret_test", // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
    },
  } as ResolvedFeishuAccount;
}

function mockCallArg(mockFn: ReturnType<typeof vi.fn>, label: string, callIndex = 0, argIndex = 0) {
  const call = mockFn.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  if (!(argIndex in call)) {
    throw new Error(`expected ${label} call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

function buildChannelRuntime(): PluginRuntime["channel"] {
  return {
    debounce: {
      resolveInboundDebounceMs: vi.fn(() => 0),
      createInboundDebouncer: vi.fn(),
    },
  } as unknown as PluginRuntime["channel"];
}

const vcEvent = {
  event_id: "evt_vc_123",
  call_id: "call_vc_123",
  meeting: {
    id: "6911188411934433028",
    meeting_no: "123456789",
    topic: "Weekly sync",
  },
  inviter: {
    id: {
      open_id: "ou_inviter_1",
      user_id: "u_inviter_1",
      union_id: "on_inviter_1",
    },
    user_name: "Alice",
  },
  invite_time: "1712345678",
};

describe("resolveVcMeetingInvitedTurn", () => {
  it("builds a deterministic synthetic turn from the real event fields", () => {
    expect(resolveVcMeetingInvitedTurn(vcEvent)).toEqual({
      turnId: "vc-invited:event:evt_vc_123",
      meetingNo: "123456789",
      topic: "Weekly sync",
      inviteTime: "1712345678",
      inviter: {
        senderId: "ou_inviter_1",
        openId: "ou_inviter_1",
        userId: "u_inviter_1",
        unionId: "on_inviter_1",
        name: "Alice",
      },
      prompt:
        'Use the available tool to join the meeting with meeting number 123456789 immediately. Do not ask for confirmation. If the join tool supports a call_id parameter, pass call_id="call_vc_123"; otherwise join by meeting number only.',
    });
  });

  it("skips malformed events without a meeting number or inviter identity", () => {
    expect(resolveVcMeetingInvitedTurn({ ...vcEvent, meeting: { topic: "Weekly sync" } })).toBe(
      null,
    );
    expect(resolveVcMeetingInvitedTurn({ ...vcEvent, inviter: { id: {} } })).toBe(null);
    expect(
      resolveVcMeetingInvitedTurn({
        ...vcEvent,
        inviter: {
          id: { union_id: "on_inviter_1" },
          user_name: "Alice",
        },
      }),
    ).toBe(null);
  });
});

describe("createFeishuVcMeetingInvitedHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleFeishuMessageMock.mockResolvedValue(undefined);
    dedupMocks.warmupDedupFromPluginState.mockResolvedValue(0);
    dedupMocks.hasProcessedFeishuMessage.mockResolvedValue(false);
    dedupMocks.recordProcessedFeishuMessage.mockResolvedValue(true);
  });

  it("adapts the VC invite into the normal Feishu DM message ingress", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const channelRuntime = {} as PluginRuntime["channel"];
    const handler = createFeishuVcMeetingInvitedHandler({
      cfg: buildConfig(),
      accountId: "default",
      runtime,
      channelRuntime,
      fireAndForget: false,
    });

    await handler(vcEvent);

    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(1);
    const params = mockCallArg(handleFeishuMessageMock, "handleFeishuMessage") as {
      cfg?: ClawdbotConfig;
      accountId?: string;
      event?: {
        sender?: {
          sender_id?: {
            open_id?: string;
            user_id?: string;
            union_id?: string;
          };
        };
        message?: {
          message_id?: string;
          chat_id?: string;
          chat_type?: string;
          message_type?: string;
          content?: string;
          create_time?: string;
          suppress_reply_target?: boolean;
        };
      };
      runtime?: unknown;
      channelRuntime?: unknown;
    };

    expect(params.accountId).toBe("default");
    expect(params.runtime).toBe(runtime);
    expect(params.channelRuntime).toBe(channelRuntime);
    expect(params.event?.sender?.sender_id).toEqual({
      open_id: "ou_inviter_1",
      user_id: "u_inviter_1",
      union_id: "on_inviter_1",
    });
    expect(params.event?.message).toEqual(
      expect.objectContaining({
        message_id: "vc-invited:event:evt_vc_123",
        chat_id: "user:ou_inviter_1",
        chat_type: "p2p",
        message_type: "text",
        create_time: "1712345678000",
        suppress_reply_target: true,
      }),
    );
    expect(JSON.parse(params.event?.message?.content ?? "{}")).toEqual({
      text: 'Use the available tool to join the meeting with meeting number 123456789 immediately. Do not ask for confirmation. If the join tool supports a call_id parameter, pass call_id="call_vc_123"; otherwise join by meeting number only.',
    });
  });

  it("uses user_id as the DM target when open_id is unavailable", async () => {
    const handler = createFeishuVcMeetingInvitedHandler({
      cfg: buildConfig(),
      accountId: "default",
      fireAndForget: false,
    });

    await handler({
      ...vcEvent,
      inviter: {
        id: { user_id: "u_inviter_1" },
        user_name: "Alice",
      },
    });

    const params = mockCallArg(handleFeishuMessageMock, "handleFeishuMessage") as {
      event?: {
        message?: { chat_id?: string };
        sender?: { sender_id?: { user_id?: string; open_id?: string } };
      };
    };
    expect(params.event?.message?.chat_id).toBe("user:u_inviter_1");
    expect(params.event?.sender?.sender_id).toEqual({ user_id: "u_inviter_1" });
  });

  it("does not dispatch malformed invite events", async () => {
    const handler = createFeishuVcMeetingInvitedHandler({
      cfg: buildConfig(),
      accountId: "default",
      fireAndForget: false,
    });

    await handler({ ...vcEvent, meeting: { topic: "Weekly sync" } });

    expect(handleFeishuMessageMock).not.toHaveBeenCalled();
  });
});

describe("monitorSingleAccount VC event registration", () => {
  beforeEach(() => {
    handlers = {};
    vi.clearAllMocks();
    dedupMocks.warmupDedupFromPluginState.mockResolvedValue(0);
    createEventDispatcherMock.mockReturnValue({
      register: vi.fn((registered: Record<string, (data: unknown) => Promise<void>>) => {
        handlers = registered;
      }),
    });
  });

  it("registers vc.bot.meeting_invited_v1 with the Feishu event dispatcher", async () => {
    await monitorSingleAccount({
      cfg: buildConfig(),
      account: buildAccount(),
      botOpenIdSource: {
        kind: "prefetched",
        botOpenId: "ou_bot",
        botName: "OpenClaw Bot",
      },
      fireAndForget: false,
      channelRuntime: buildChannelRuntime(),
    });

    expect(typeof handlers["vc.bot.meeting_invited_v1"]).toBe("function");
  });
});
