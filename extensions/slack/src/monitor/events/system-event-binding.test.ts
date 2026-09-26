import type { AllMiddlewareArgs, MessageShortcut, SlackShortcutMiddlewareArgs } from "@slack/bolt";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSlackSystemEventRouteResolver } from "../system-event-session.js";
import { registerSlackChannelEvents } from "./channels.js";
import { registerModalLifecycleHandler } from "./interactions.modal.js";
import { registerSlackShortcutHandler } from "./interactions.shortcuts.js";
import { registerSlackPinEvents } from "./pins.js";
import { createSlackSystemEventTestHarness } from "./system-event-test-harness.js";

const { enqueue, heartbeat } = vi.hoisted(() => ({
  enqueue: vi.fn(() => true),
  heartbeat: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({ enqueueRoutedSystemEvent: enqueue }));
vi.mock("openclaw/plugin-sdk/heartbeat-runtime", () => ({ requestHeartbeat: heartbeat }));

const channelId = "C1";
const threadTs = "200.100";
const baseSessionKey = "agent:main:slack:channel:c1";
const depthAlias = "agent:main:dashboard:legacy-child";
const spawnedAlias = "agent:main:dashboard:spawned-child";
const userAcp = "agent:main:acp:user-owned";
const userThread = "agent:main:slack:channel:c2:thread:ordinary";
const userDashboard = "agent:main:dashboard:user-owned";
let state: OpenClawTestState;
let adapter: SessionBindingAdapter | undefined;

beforeAll(async () => {
  state = await createOpenClawTestState({ label: "slack-system-event-binding" });
  const entries = [
    { sessionKey: depthAlias, spawnDepth: 1 },
    { sessionKey: spawnedAlias, spawnedBy: "agent:main:main" },
    { sessionKey: userAcp, spawnDepth: 0, parentSessionKey: "agent:main:main" },
    { sessionKey: userThread, parentSessionKey: baseSessionKey },
    { sessionKey: userDashboard, parentSessionKey: "agent:main:main" },
  ];
  for (const { sessionKey, ...lineage } of entries) {
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      entry: { sessionId: sessionKey.replaceAll(":", "-"), updatedAt: 1, ...lineage },
    });
  }
});
afterAll(async () => await state.cleanup());
beforeEach(() => {
  enqueue.mockClear();
  heartbeat.mockClear();
  setRuntimeConfigSnapshot({});
});
afterEach(() => {
  if (adapter) {
    unregisterSessionBindingAdapter({ channel: "slack", accountId: "default", adapter });
    adapter = undefined;
  }
  clearRuntimeConfigSnapshot();
});

function savedBinding(targetSessionKey: string, threaded = false): SessionBindingRecord {
  return {
    bindingId: "legacy-binding",
    targetKind: "session",
    targetSessionKey,
    conversation: {
      channel: "slack",
      accountId: "default",
      conversationId: threaded ? threadTs : channelId,
      ...(threaded ? { parentConversationId: channelId } : {}),
    },
    metadata: { boundBy: "human-1" },
    status: "active",
    boundAt: 1,
  };
}

function installBinding(saved: SessionBindingRecord | null) {
  const lookup = (ref: Parameters<SessionBindingAdapter["resolveByConversation"]>[0]) =>
    saved?.conversation.conversationId === ref.conversationId ? saved : null;
  const inspect = vi.fn(async (ref: Parameters<typeof lookup>[0]) => lookup(ref));
  const touch = vi.fn(async () => {});
  adapter = {
    channel: "slack",
    accountId: "default",
    listBySession: () => (saved ? [saved] : []),
    resolveByConversation: lookup,
    inspectByConversationAsync: inspect,
    touchAsync: touch,
  };
  registerSessionBindingAdapter(adapter);
  return { inspect, touch, adapter };
}

function createContext() {
  const harness = createSlackSystemEventTestHarness({ channelType: "channel", allowFrom: ["*"] });
  const { ctx } = harness;
  ctx.cfg = {};
  ctx.accountId = "default";
  ctx.channelsConfigKeys = [];
  ctx.resolveSlackSystemEventRoute = createSlackSystemEventRouteResolver({
    cfg: ctx.cfg,
    accountId: ctx.accountId,
    getTeamId: () => ctx.teamId,
    mainKey: "agent:main:main",
    threadInheritParent: false,
    recallSlackChannelType: () => "channel",
  });
  return harness;
}

type ShortcutArgs = SlackShortcutMiddlewareArgs & Pick<AllMiddlewareArgs, "context" | "client">;
function createShortcut() {
  const { ctx } = createContext();
  const shortcut =
    vi.fn<(_pattern: RegExp, handler: (args: ShortcutArgs) => Promise<void>) => void>();
  Object.assign(ctx.app, { shortcut });
  registerSlackShortcutHandler({ ctx, formatSystemEvent: JSON.stringify });
  const handler = shortcut.mock.calls[0]?.[1];
  if (!handler) {
    throw new Error("Expected registered Slack shortcut handler");
  }
  const body: MessageShortcut = {
    type: "message_action",
    callback_id: "summarize-message",
    trigger_id: "synthetic-trigger",
    response_url: "https://slack.invalid/response",
    message_ts: "200.300",
    message: {
      type: "message",
      user: "U456",
      ts: "200.300",
      text: "Selected message",
      thread_ts: threadTs,
    },
    user: { id: "U123", name: "alice", team_id: "T_TEST" },
    channel: { id: channelId, name: "general" },
    team: { id: "T_TEST", domain: "example" },
    token: "synthetic-token",
    action_ts: "200.400",
  };
  return () =>
    handler({
      ack: vi.fn(),
      respond: vi.fn(),
      body,
      payload: body,
      shortcut: body,
      context: { teamId: "T_TEST", isEnterpriseInstall: false },
      client: ctx.app.client,
    });
}

it.each([
  { target: depthAlias, threaded: true, allowed: false },
  { target: spawnedAlias, threaded: false, allowed: false },
  { target: userAcp, threaded: true, allowed: true },
  { target: userThread, threaded: true, allowed: true },
  { target: userDashboard, threaded: false, allowed: true },
  { target: null, threaded: false, allowed: false },
])(
  "admits a message shortcut without giving delegated aliases ownership: $target",
  async ({ target, threaded, allowed }) => {
    const { inspect, touch } = installBinding(target ? savedBinding(target, threaded) : null);
    await createShortcut()();
    const expectedSessionKey = allowed ? target : `${baseSessionKey}:thread:${threadTs}`;
    expect(inspect).toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({ agentId: "main", sessionKey: expectedSessionKey }),
      expect.objectContaining({ deliveryContext: expect.objectContaining({ threadId: threadTs }) }),
    );
    expect(heartbeat).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionKey: expectedSessionKey }),
    );
    if (!allowed) {
      expect(touch).not.toHaveBeenCalled();
    }
  },
);

it.each(["channel_created", "pin_added"])(
  "does not enqueue %s to a saved delegated dashboard alias",
  async (eventName) => {
    const { touch } = installBinding(savedBinding(depthAlias));
    const harness = createContext();
    registerSlackChannelEvents({ ctx: harness.ctx });
    registerSlackPinEvents({ ctx: harness.ctx });
    const handler = harness.getHandler(eventName);
    if (!handler) {
      throw new Error("Expected registered Slack system event handler");
    }
    await handler({
      event:
        eventName === "channel_created"
          ? { channel: { id: channelId, name: "general" } }
          : {
              user: "U123",
              channel_id: channelId,
              item: { type: "message", message: { ts: "200.300" } },
            },
      body: { event_id: "Ev-legacy-binding" },
    });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({ sessionKey: baseSessionKey }),
      expect.any(Object),
    );
    expect(touch).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
  },
);

it("waits for binding admission and fails before enqueue or heartbeat when inspection fails", async () => {
  const { inspect, touch } = installBinding(savedBinding(userAcp, true));
  const entered = createDeferred<void>();
  const release = createDeferred<SessionBindingRecord | null>();
  inspect.mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });
  const pending = createShortcut()();
  const rejected = expect(pending).rejects.toThrow("binding inspection failed");
  await entered.promise;
  expect(enqueue).not.toHaveBeenCalled();
  expect(heartbeat).not.toHaveBeenCalled();
  release.reject(new Error("binding inspection failed"));
  await rejected;
  expect(enqueue).not.toHaveBeenCalled();
  expect(heartbeat).not.toHaveBeenCalled();
  expect(touch).not.toHaveBeenCalled();
});

it("does not fall back when the binding owner disappears during inspection", async () => {
  const saved = savedBinding(userAcp, true);
  const { inspect, touch, adapter: registered } = installBinding(saved);
  inspect.mockImplementationOnce(async () => {
    unregisterSessionBindingAdapter({
      channel: "slack",
      accountId: "default",
      adapter: registered,
    });
    return saved;
  });
  await expect(createShortcut()()).rejects.toThrow("binding owner is unavailable");
  expect(enqueue).not.toHaveBeenCalled();
  expect(heartbeat).not.toHaveBeenCalled();
  expect(touch).not.toHaveBeenCalled();
});

it("rejects a binding replaced during asynchronous policy admission before side effects", async () => {
  const saved = savedBinding(userAcp, true);
  const { inspect, touch } = installBinding(saved);
  inspect
    .mockResolvedValueOnce(saved)
    .mockResolvedValue({ ...saved, targetSessionKey: depthAlias });
  await expect(createShortcut()()).rejects.toThrow(/changed/i);
  expect(enqueue).not.toHaveBeenCalled();
  expect(heartbeat).not.toHaveBeenCalled();
  expect(touch).not.toHaveBeenCalled();
});

it.each([depthAlias, spawnedAlias, userAcp, userDashboard])(
  "admits modal session metadata without allowing direct worker targets: %s",
  async (sessionKey) => {
    const { ctx } = createContext();
    const register = vi.fn<Parameters<typeof registerModalLifecycleHandler>[0]["register"]>();
    registerModalLifecycleHandler({
      register,
      matcher: /^openclaw:/,
      ctx,
      interactionType: "view_submission",
      contextPrefix: "slack:interaction:view",
      summarizeViewState: () => [],
      formatSystemEvent: JSON.stringify,
    });
    const handler = register.mock.calls[0]?.[1];
    if (!handler) {
      throw new Error("Expected modal handler");
    }
    const pending = handler({
      ack: vi.fn(),
      context: { teamId: "T_TEST", isEnterpriseInstall: false },
      client: ctx.app.client,
      body: {
        user: { id: "U123" },
        view: {
          id: "V1",
          callback_id: "openclaw:test",
          private_metadata: JSON.stringify({
            sessionKey,
            channelId,
            channelType: "channel",
            userId: "U123",
          }),
        },
      },
    });
    if (sessionKey === depthAlias || sessionKey === spawnedAlias) {
      await expect(pending).rejects.toThrow("cannot target delegated workers");
      expect(enqueue).not.toHaveBeenCalled();
      expect(heartbeat).not.toHaveBeenCalled();
    } else {
      await pending;
      expect(enqueue).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sessionKey }),
        expect.any(Object),
      );
    }
  },
);
