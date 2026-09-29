import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type * as FeishuBotModule from "./bot.js";
import { feishuDedupeState } from "./dedup-state.js";
import type * as FeishuDedupModule from "./dedup.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";
import { monitorSingleAccount } from "./monitor.account.js";
import { createFeishuVcMeetingInvitedHandler } from "./monitor.vc-meeting-invited-handler.js";
import { getFeishuSyntheticDirectPreDispatchTarget } from "./synthetic-event-target.js";
import type { ResolvedFeishuAccount } from "./types.js";

const handleFeishuMessageMock = vi.hoisted(() =>
  vi.fn<typeof FeishuBotModule.handleFeishuMessage>(),
);
const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));
const createFeishuThreadBindingManagerMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));
const dedupMocks = vi.hoisted(() => ({
  claimUnprocessedFeishuMessage: vi.fn<typeof FeishuDedupModule.claimUnprocessedFeishuMessage>(),
  warmupDedupFromPluginState: vi.fn(async () => 0),
  hasProcessedFeishuMessage: vi.fn(async () => false),
}));

let handlers: Record<string, (data: unknown) => Promise<void>> = {};

vi.mock("./bot.js", async () => {
  const actual = await vi.importActual<typeof FeishuBotModule>("./bot.js");
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
  const actual = await vi.importActual<typeof FeishuDedupModule>("./dedup.js");
  return {
    ...actual,
    claimUnprocessedFeishuMessage: dedupMocks.claimUnprocessedFeishuMessage,
    warmupDedupFromPluginState: dedupMocks.warmupDedupFromPluginState,
    hasProcessedFeishuMessage: dedupMocks.hasProcessedFeishuMessage,
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

function buildAccount(config?: Partial<ResolvedFeishuAccount["config"]>): ResolvedFeishuAccount {
  return {
    accountId: "default",
    selectionSource: "explicit",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "test-app-secret",
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
      ...config,
    },
  } as ResolvedFeishuAccount;
}

function buildChannelRuntime(): PluginRuntime["channel"] {
  return {
    inbound: {},
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

beforeEach(() => {
  vi.clearAllMocks();
  handleFeishuMessageMock.mockReset();
  handleFeishuMessageMock.mockResolvedValue(undefined);
  feishuDedupeState.guard = createChannelReplayGuard<string | null | undefined>({
    dedupe: { ttlMs: 24 * 60 * 60 * 1000, memoryMaxSize: 1000 },
    buildReplayKey: (key) => key,
  });
  dedupMocks.claimUnprocessedFeishuMessage.mockReset();
  dedupMocks.claimUnprocessedFeishuMessage.mockImplementation(({ messageId, namespace }) =>
    feishuDedupeState.guard.claim(messageId, { namespace }),
  );
  dedupMocks.warmupDedupFromPluginState.mockResolvedValue(0);
  dedupMocks.hasProcessedFeishuMessage.mockResolvedValue(false);
});
afterEach(() => feishuDedupeState.reset());

function createHandler(options?: {
  autoJoin?: boolean;
  abortSignal?: AbortSignal;
  isAccountActive?: () => boolean;
}) {
  return createFeishuVcMeetingInvitedHandler({
    cfg: buildConfig(),
    accountId: "default",
    runtime: createRuntimeSpies(),
    channelRuntime: buildChannelRuntime(),
    fireAndForget: false,
    autoJoin: true,
    ...options,
  });
}

describe("createFeishuVcMeetingInvitedHandler", () => {
  it("releases failed invitations for redelivery and preserves adopted replay ownership after stop", async () => {
    const invitation = { ...vcEvent, inviter: { id: { user_id: "u_inviter_1" } } };
    let adopted: FeishuIngressLifecycle | undefined;
    handleFeishuMessageMock.mockRejectedValueOnce(new Error("pre-adoption failure"));
    handleFeishuMessageMock.mockImplementation(async ({ turnAdoptionLifecycle }) => {
      adopted = turnAdoptionLifecycle;
      await adopted?.onAdopted();
    });
    const controller = new AbortController();
    const handler = createHandler({ abortSignal: controller.signal });
    await handler(invitation);
    await handler(invitation);
    await handler(invitation);
    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(2);
    const event = handleFeishuMessageMock.mock.calls[0]?.[0].event;
    if (!event) {
      throw new Error("Expected an invitation dispatch");
    }
    expect(getFeishuSyntheticDirectPreDispatchTarget(event)).toBe("user:u_inviter_1");
    expect(event.message.content).toContain("123456789");
    expect(event.message.content).toContain("call_vc_123");
    const key = resolveFeishuMessageDedupeKey(event);
    expect(key).not.toBe(event.message.message_id);
    expect(await feishuDedupeState.guard.hasRecent(key, { namespace: "default" })).toBe(true);
    controller.abort();
    expect(adopted?.abortSignal.aborted).toBe(false);
    await createHandler()(invitation);
    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch malformed invite events", async () => {
    const handler = createHandler();
    await handler({ ...vcEvent, meeting: { topic: "Weekly sync" } });
    await handler({ ...vcEvent, inviter: { id: {} } });
    await handler({ ...vcEvent, meeting: { meeting_no: "not-a-meeting" } });
    expect(handleFeishuMessageMock).not.toHaveBeenCalled();
    expect(dedupMocks.claimUnprocessedFeishuMessage).not.toHaveBeenCalled();
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

  it("keeps meeting invitations inert until the live account opts in", async () => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    monitorWebSocketMock.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
    });
    const monitor = monitorSingleAccount({
      cfg: buildConfig(),
      account: buildAccount(),
      botOpenIdSource: {
        kind: "prefetched",
        botOpenId: "ou_bot",
      },
      fireAndForget: false,
      channelRuntime: buildChannelRuntime(),
    });

    try {
      await started.promise;
      expect(typeof handlers["vc.bot.meeting_invited_v1"]).toBe("function");
      await handlers["vc.bot.meeting_invited_v1"]?.(vcEvent);
      expect(handleFeishuMessageMock).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await monitor;
    }
  });

  it("abandons deferred invitation ownership when the account transport ends", async () => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    let lifecycle: FeishuIngressLifecycle | undefined;
    handleFeishuMessageMock.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      lifecycle = turnAdoptionLifecycle;
      lifecycle?.onDeferred();
    });
    handleFeishuMessageMock.mockImplementation(async ({ turnAdoptionLifecycle }) => {
      await turnAdoptionLifecycle?.onAdopted();
    });
    monitorWebSocketMock.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
    });
    const monitor = monitorSingleAccount({
      cfg: buildConfig(),
      account: buildAccount({ vcAutoJoin: true }),
      botOpenIdSource: { kind: "prefetched", botOpenId: "ou_bot" },
      fireAndForget: false,
      channelRuntime: buildChannelRuntime(),
    });
    try {
      await started.promise;
      const handler = handlers["vc.bot.meeting_invited_v1"];
      if (!handler) {
        throw new Error("VC invitation handler was not registered");
      }
      await handler(vcEvent);
      const key = dedupMocks.claimUnprocessedFeishuMessage.mock.calls[0]?.[0].messageId;
      expect((await feishuDedupeState.guard.claim(key, { namespace: "default" })).kind).toBe(
        "inflight",
      );
      finish.resolve();
      await monitor;
      expect(lifecycle?.abortSignal.aborted).toBe(true);
      expect(() => lifecycle?.onAdopted()).toThrow();
      await handler(vcEvent);
      expect(handleFeishuMessageMock).toHaveBeenCalledOnce();
      await createHandler()(vcEvent);
      expect(handleFeishuMessageMock).toHaveBeenCalledTimes(2);
      expect(await feishuDedupeState.guard.hasRecent(key, { namespace: "default" })).toBe(true);
    } finally {
      finish.resolve();
      await monitor;
    }
  });
});
