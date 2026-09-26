import { existsSync } from "node:fs";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { getReplyFromConfig } from "openclaw/plugin-sdk/reply-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { slackPlugin } from "../../../channel-plugin-api.js";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackRoutingContext } from "./prepare-routing.js";
import { createSlackTestAccount } from "./prepare.test-helpers.js";

type Conversation = Parameters<SessionBindingAdapter["resolveByConversation"]>[0];
let state: OpenClawTestState;
let adapter: SessionBindingAdapter | undefined;
beforeAll(async () => {
  state = await createOpenClawTestState({
    label: "slack-route-owner-admission",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
});
afterAll(async () => await state.cleanup());
beforeEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackPlugin }]),
  );
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  if (adapter) {
    unregisterSessionBindingAdapter({ channel: "slack", accountId: "default", adapter });
    adapter = undefined;
  }
  resetPluginRuntimeStateForTest();
});

it.each([
  "none-to-global",
  "plugin-to-global",
  "plugin-stable",
  "configured-stable",
  "configured-race",
  "child-over-base-stable",
  "child-over-base-race",
  "derived-none-stable",
  "derived-none-to-global",
  "ordinary-dm-thread-stable",
] as const)("carries Slack routing into reply ownership validation: %s", async (scenario) => {
  const configured = scenario.startsWith("configured-");
  const childOverBase = scenario.startsWith("child-over-base-");
  const derived = scenario.startsWith("derived-");
  const direct = scenario === "ordinary-dm-thread-stable";
  const threaded = childOverBase || derived || direct;
  const changes = scenario.endsWith("to-global") || scenario.endsWith("race");
  const channelId = direct ? "D123" : "C123";
  const baseId = direct ? "user:U1" : channelId;
  const threadTs = "1770408518.000001";
  const mainWorkspace = state.path(scenario, "main-workspace");
  const workWorkspace = state.path(scenario, "work-workspace");
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: { workspace: mainWorkspace }, work: { workspace: workWorkspace } },
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "openai/gpt-5.4" },
      },
    },
    plugins: { enabled: false },
    session: { scope: derived ? "per-sender" : "global", dmScope: "main" },
    channels: { slack: { enabled: true, replyToMode: "all" } },
    bindings: [
      { agentId: "main", match: { channel: "slack", accountId: "default" } },
      ...(configured
        ? [
            {
              type: "acp" as const,
              agentId: "work",
              match: {
                channel: "slack",
                accountId: "default",
                peer: { kind: "channel" as const, id: channelId },
              },
            },
          ]
        : []),
    ],
  };
  setRuntimeConfigSnapshot(cfg);
  const baseConversation: Conversation = {
    channel: "slack",
    accountId: "default",
    conversationId: baseId,
  };
  const childConversation: Conversation = {
    ...baseConversation,
    conversationId: threadTs,
    parentConversationId: baseId,
  };
  const replacement: SessionBindingRecord = {
    bindingId: "new-global",
    targetSessionKey: "global",
    targetKind: "session",
    status: "active",
    boundAt: 2,
    conversation: baseConversation,
    metadata: { agentId: "work" },
  };
  const records = new Map<string, SessionBindingRecord>();
  if (childOverBase) {
    records.set(baseId, {
      ...replacement,
      bindingId: "existing-base",
      boundAt: 1,
      metadata: { agentId: "main" },
    });
  } else if (scenario.startsWith("plugin-")) {
    records.set(baseId, {
      ...replacement,
      targetSessionKey: "plugin-binding:synthetic:source",
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "synthetic",
        pluginRoot: state.path("plugin"),
      },
    });
  }
  const lookup = (ref: Conversation) => records.get(ref.conversationId) ?? null;
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  let armed = false;
  let reached = false;
  const admissionReads: Conversation[] = [];
  const read = async (ref: Conversation) => {
    if (armed) {
      armed = false;
      reached = true;
      entered.resolve();
      await release.promise;
    }
    if (reached) {
      admissionReads.push(ref);
    }
    return lookup(ref);
  };
  adapter = {
    channel: "slack",
    accountId: "default",
    listBySession: () => [],
    resolveByConversation: lookup,
    inspectByConversationAsync: read,
    resolveByConversationAsync: read,
    touchAsync: async () => {},
  };
  registerSessionBindingAdapter(adapter);
  const message: SlackMessageEvent = {
    type: "message",
    channel: channelId,
    channel_type: direct ? "im" : "channel",
    user: "U1",
    text: "hello",
    ts: "1770408518.000002",
    ...(threaded ? { thread_ts: threadTs } : {}),
  };
  const prepared = resolveSlackRoutingContext({
    ctx: { cfg, teamId: "T1", threadInheritParent: false, threadHistoryScope: "thread" },
    account: createSlackTestAccount({ replyToMode: "all" }),
    message,
    isDirectMessage: direct,
    isGroupDm: false,
    isRoom: !direct,
    isRoomish: !direct,
  });
  const route = prepared.route;
  expect(route.agentId).toBe(configured ? "work" : "main");
  if (configured) {
    expect(route.sessionKey).toContain("agent:work:acp:");
  }
  const ctx = buildChannelInboundEventContext({
    channel: "slack",
    accountId: "default",
    messageId: scenario,
    from: direct ? "slack:U1" : `slack:channel:${channelId}`,
    sender: { id: "U1" },
    conversation: {
      kind: direct ? "direct" : "channel",
      id: channelId,
      threadId: threaded ? threadTs : undefined,
    },
    route: {
      ...route,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: prepared.sessionKey,
      parentSessionKey: prepared.threadKeys.parentSessionKey,
    },
    reply: { to: direct ? "user:U1" : `channel:${channelId}` },
    command: { kind: "text-slash", name: "help", authorized: true, body: "/help" },
    access: { commands: { authorized: true } },
    message: { rawBody: "/help", commandBody: "/help" },
  });
  if (derived) {
    expect(ctx.SessionKey).not.toBe(route.sessionKey);
  }
  if (direct || childOverBase) {
    expect(ctx.SessionKey).toBe(route.sessionKey);
  }
  const abort = new AbortController();
  const adopted = vi.fn(async () => {});
  armed = true;
  // Stable controls cancel at the real owner-read barrier; raced requests remain active.
  const settled = getReplyFromConfig(
    ctx,
    {
      abortSignal: abort.signal,
      turnAdoptionLifecycle: { onAdopted: adopted, onAbandoned: () => {} },
    },
    cfg,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  await Promise.race([entered.promise, settled]);
  if (reached && changes) {
    const next = childOverBase ? { ...replacement, conversation: childConversation } : replacement;
    records.set(next.conversation.conversationId, next);
  }
  if (!changes) {
    abort.abort();
  }
  release.resolve();
  const outcome = await settled;
  expect(reached).toBe(true);
  expect(outcome).toMatchObject(
    changes ? { code: "SESSION_WORK_START_CHANGED" } : { name: "AbortError" },
  );
  if (scenario === "child-over-base-stable" || direct) {
    expect(admissionReads).toEqual(
      expect.arrayContaining([
        expect.objectContaining(childConversation),
        expect.objectContaining(baseConversation),
      ]),
    );
  }
  expect(adopted).not.toHaveBeenCalled();
  expect(existsSync(mainWorkspace)).toBe(false);
  expect(existsSync(workWorkspace)).toBe(false);
});
