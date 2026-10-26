import { EventDispatcher } from "@larksuiteoapi/node-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type * as FeishuBotModule from "./bot.js";
import { feishuDedupeState } from "./dedup-state.js";
import type * as FeishuDedupModule from "./dedup.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";
import { monitorSingleAccount } from "./monitor.account.js";
import { createFeishuTestIngressQueue } from "./monitor.test-mocks.js";
import { createFeishuVcMeetingInvitedHandler } from "./monitor.vc-meeting-invited-handler.js";
import { setFeishuRuntime } from "./runtime.js";
import { getFeishuSyntheticDirectPreDispatchTarget } from "./synthetic-event-target.js";
import type { ResolvedFeishuAccount } from "./types.js";

const handleFeishuMessageMock = vi.hoisted(() =>
  vi.fn<typeof FeishuBotModule.handleFeishuMessage>(),
);
const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));
const createFeishuThreadBindingManagerMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));
const sendCardFeishuMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "m1", chatId: "c1" })));
const dedupMocks = vi.hoisted(() => ({
  claimUnprocessedFeishuMessage: vi.fn<typeof FeishuDedupModule.claimUnprocessedFeishuMessage>(),
  warmupDedupFromPluginState: vi.fn(async () => 0),
  hasProcessedFeishuMessage: vi.fn(async () => false),
}));

let dispatcher: EventDispatcher;
vi.mock("./bot.js", async () => ({
  ...(await vi.importActual<typeof FeishuBotModule>("./bot.js")),
  handleFeishuMessage: handleFeishuMessageMock,
}));
// mock-isolation: Capture dispatcher registration without constructing a real Feishu client.
vi.mock("./client.js", () => ({ createEventDispatcher: createEventDispatcherMock }));
vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));

vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: createFeishuThreadBindingManagerMock,
}));

vi.mock("./dedup.js", async () => ({
  ...(await vi.importActual<typeof FeishuDedupModule>("./dedup.js")),
  ...dedupMocks,
}));

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  sendCardFeishu: sendCardFeishuMock,
}));

function buildConfig(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        dmPolicy: "open",
        allowFrom: ["*"],
      },
    },
  } as ClawdbotConfig;
}

function buildAccount(config?: Partial<ResolvedFeishuAccount["config"]>): ResolvedFeishuAccount {
  return {
    accountId: "default",
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
const vcEnvelope = {
  schema: "2.0",
  header: { event_type: "vc.bot.meeting_invited_v1" },
  event: vcEvent,
};

beforeEach(() => {
  vi.clearAllMocks();
  handleFeishuMessageMock.mockReset().mockResolvedValue(undefined);
  sendCardFeishuMock.mockReset().mockResolvedValue({ messageId: "m1", chatId: "c1" });
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
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  feishuDedupeState.reset();
});

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

function startMonitor(vcAutoJoin?: boolean, runtime = createRuntimeSpies()) {
  const started = createDeferred<void>();
  const finish = createDeferred<void>();
  monitorWebSocketMock.mockImplementationOnce(async () => {
    started.resolve();
    await finish.promise;
  });
  const monitor = monitorSingleAccount({
    cfg: buildConfig(),
    account: buildAccount(vcAutoJoin === undefined ? undefined : { vcAutoJoin }),
    botOpenIdSource: { kind: "prefetched", botOpenId: "ou_bot" },
    fireAndForget: false,
    channelRuntime: buildChannelRuntime(),
    runtime,
  });
  return { started: started.promise, finish: finish.resolve, monitor };
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

describe("monitorSingleAccount synthetic event registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dedupMocks.warmupDedupFromPluginState.mockResolvedValue(0);
    dispatcher = new EventDispatcher({});
    createEventDispatcherMock.mockReturnValue(dispatcher);
    setFeishuRuntime(
      createPluginRuntimeMock({
        state: { openChannelIngressQueue: createFeishuTestIngressQueue },
      }),
    );
  });

  const menuEnvelope = (eventKey: string, timestamp: string) => ({
    schema: "2.0",
    header: { event_type: "application.bot.menu_v6" },
    event: {
      event_key: eventKey,
      timestamp,
      operator: { operator_id: { open_id: "ou_user1", user_id: "user_1", union_id: "union_1" } },
    },
  });

  it("falls back to the legacy /menu synthetic message path for unrelated bot menu keys", async () => {
    const { started, finish, monitor } = startMonitor();
    try {
      await started;
      await dispatcher.invoke(menuEnvelope("custom-key", "1700000000002"));

      expect(handleFeishuMessageMock).toHaveBeenCalledOnce();
      expect(handleFeishuMessageMock.mock.calls[0]?.[0]).toMatchObject({
        botOpenId: "ou_bot",
        event: { message: { content: '{"text":"/menu custom-key"}' } },
      });
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
    } finally {
      finish();
      await monitor;
    }
  });

  it("reports a fallback failure without reopening the committed menu event", async () => {
    const runtime = createRuntimeSpies();
    const { started, finish, monitor } = startMonitor(undefined, runtime);
    const event = menuEnvelope("quick-actions", "1700000000004");
    sendCardFeishuMock.mockRejectedValueOnce(new Error("launcher unavailable"));
    handleFeishuMessageMock.mockRejectedValueOnce(new Error("fallback failed"));
    try {
      await started;
      await dispatcher.invoke(event);
      expect(runtime.error).toHaveBeenCalledWith(
        "feishu[default]: error handling bot menu event: Error: fallback failed",
      );
      await dispatcher.invoke(event);

      expect(sendCardFeishuMock).toHaveBeenCalledOnce();
      expect(handleFeishuMessageMock).toHaveBeenCalledOnce();
    } finally {
      finish();
      await monitor;
    }
  });

  it("keeps meeting invitations inert until the live account opts in", async () => {
    const { started, finish, monitor } = startMonitor();
    try {
      await started;
      await expect(dispatcher.invoke(vcEnvelope)).resolves.toBeUndefined();
      expect(handleFeishuMessageMock).not.toHaveBeenCalled();
    } finally {
      finish();
      await monitor;
    }
  });

  it("abandons deferred invitation ownership when the account transport ends", async () => {
    let lifecycle: FeishuIngressLifecycle | undefined;
    handleFeishuMessageMock.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      lifecycle = turnAdoptionLifecycle;
      lifecycle?.onDeferred();
    });
    handleFeishuMessageMock.mockImplementation(async ({ turnAdoptionLifecycle }) => {
      await turnAdoptionLifecycle?.onAdopted();
    });
    const { started, finish, monitor } = startMonitor(true);
    try {
      await started;
      await dispatcher.invoke(vcEnvelope);
      const key = dedupMocks.claimUnprocessedFeishuMessage.mock.calls[0]?.[0].messageId;
      expect((await feishuDedupeState.guard.claim(key, { namespace: "default" })).kind).toBe(
        "inflight",
      );
      finish();
      await monitor;
      expect(lifecycle?.abortSignal.aborted).toBe(true);
      expect(() => lifecycle?.onAdopted()).toThrow();
      await dispatcher.invoke(vcEnvelope);
      expect(handleFeishuMessageMock).toHaveBeenCalledOnce();
      await createHandler()(vcEvent);
      expect(handleFeishuMessageMock).toHaveBeenCalledTimes(2);
      expect(await feishuDedupeState.guard.hasRecent(key, { namespace: "default" })).toBe(true);
    } finally {
      finish();
      await monitor;
    }
  });
});
