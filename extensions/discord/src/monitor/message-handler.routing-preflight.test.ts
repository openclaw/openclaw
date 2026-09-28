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
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { discordPlugin } from "../../channel-plugin-api.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
} from "./message-handler.preflight.test-helpers.js";
import { resolveDiscordPreflightRoute } from "./message-handler.routing-preflight.js";
import { resolveDiscordAutoThreadContext } from "./threading.js";

const scope = { channel: "discord", accountId: "default" };
const channelId = "channel-1";
type Conversation = Parameters<SessionBindingAdapter["resolveByConversation"]>[0];
let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({
    label: "discord-routing",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
});
afterAll(async () => await state.cleanup());
beforeEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordPlugin }]),
  );
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

function binding(targetSessionKey: string, conversationId = channelId): SessionBindingRecord {
  return {
    bindingId: "binding-1",
    targetSessionKey,
    targetKind: "session",
    status: "active",
    boundAt: 1,
    conversation: { ...scope, conversationId },
  };
}

async function prepare(cfg: OpenClawConfig, adapter: SessionBindingAdapter, direct = false) {
  const message = createDiscordMessage({
    id: "message-1",
    channelId,
    content: "hello",
    author: { id: "user-1", bot: false },
  });
  const author = message.author;
  if (!author) {
    throw new Error("Expected a sender in the Discord fixture");
  }
  const preflight = createDiscordPreflightArgs({
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    data: direct
      ? { channel_id: channelId, author, message }
      : createGuildEvent({ channelId, guildId: "guild-1", author, message }),
    client: createGuildTextClient(channelId),
  });
  // Register after the maintained fixture's empty owner; it owns thread-manager cleanup.
  registerSessionBindingAdapter(adapter);
  onTestFinished(() => unregisterSessionBindingAdapter({ ...scope, adapter }));
  return resolveDiscordPreflightRoute({
    preflight,
    author,
    isDirectMessage: direct,
    isGroupDm: false,
    messageChannelId: channelId,
    memberRoleIds: [],
  });
}

it.each(["ambiguous", "main-session"])(
  "resolves conversation bindings with %s routing",
  async (routing) => {
    const mainSession = routing === "main-session";
    const record = binding(mainSession ? "agent:second:home" : "agent:second:acp:bound-session");
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { first: {}, second: {} } },
    };
    if (mainSession) {
      cfg.bindings = [{ agentId: "first", match: { channel: "discord" } }];
      cfg.session = { mainKey: "home" };
    }
    const result = await prepare(cfg, {
      ...scope,
      listBySession: () => [record],
      resolveByConversation: (ref) => (ref.conversationId === channelId ? record : null),
    });
    expect(result.effectiveRoute.agentId).toBe("second");
    expect(result.baseSessionKey).toBe(record.targetSessionKey);
    expect(result.threadBinding).toEqual(record);
    if (mainSession) {
      expect(result.effectiveRoute).toMatchObject({
        sessionKey: "agent:second:home",
        mainSessionKey: "agent:second:home",
        lastRoutePolicy: "main",
      });
    }
  },
);

it.each(["plugin", "configured", "ignored-stale", "derived", "dm"])(
  "rejects changed Discord %s ownership before adopting a reply",
  async (scenario) => {
    const direct = scenario === "dm";
    const configured = scenario === "configured";
    const stale = scenario === "ignored-stale";
    const mainWorkspace = state.path(scenario, "main-workspace");
    const workWorkspace = state.path(scenario, "work-workspace");
    const bindings: NonNullable<OpenClawConfig["bindings"]> = [
      { agentId: stale ? "work" : "main", match: scope },
    ];
    if (configured) {
      bindings.push({
        type: "acp",
        agentId: "work",
        match: { ...scope, peer: { kind: "channel", id: channelId } },
      });
    }
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
      session: { scope: stale || scenario === "derived" ? "per-sender" : "global" },
      channels: { discord: { enabled: true } },
      bindings,
    };
    setRuntimeConfigSnapshot(cfg);
    const conversation = { ...scope, conversationId: direct ? "user:user-1" : channelId };
    let current: SessionBindingRecord | null = stale
      ? binding(`agent:main:discord:channel:${channelId}`)
      : scenario === "plugin"
        ? {
            ...binding("plugin-binding:synthetic:source"),
            metadata: {
              pluginBindingOwner: "plugin",
              pluginId: "synthetic",
              pluginRoot: state.path("plugin"),
            },
          }
        : null;
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const lookup = (ref: Conversation) =>
      ref.conversationId === conversation.conversationId ? current : null;
    const read = vi.fn(async (ref: Conversation) => {
      entered.resolve();
      await release.promise;
      return lookup(ref);
    });
    const { effectiveRoute: route } = await prepare(
      cfg,
      {
        ...scope,
        listBySession: () => [],
        resolveByConversation: lookup,
        inspectByConversationAsync: read,
        resolveByConversationAsync: read,
        touchAsync: async () => {},
      },
      direct,
    );
    expect(route.agentId).toBe(configured || stale ? "work" : "main");
    if (configured) {
      expect(route.sessionKey).toContain("agent:work:acp:");
    }
    if (stale) {
      expect(route.sessionKey).toBe(`agent:work:discord:channel:${channelId}`);
    }
    const autoThread =
      scenario === "derived"
        ? resolveDiscordAutoThreadContext({
            agentId: route.agentId,
            channel: "discord",
            parentSessionKey: route.sessionKey,
            createdThreadId: "new-thread",
          })
        : null;
    const ctx = buildChannelInboundEventContext({
      ...scope,
      messageId: scenario,
      from: direct ? "discord:user-1" : `discord:channel:${channelId}`,
      sender: { id: "user-1" },
      conversation: {
        kind: direct ? "direct" : "channel",
        id: channelId,
        threadId: autoThread?.createdThreadId,
      },
      route: {
        ...route,
        routeSessionKey: route.sessionKey,
        dispatchSessionKey: autoThread?.SessionKey ?? route.sessionKey,
      },
      reply: { to: direct ? "user:user-1" : `channel:${channelId}` },
      command: { kind: "text-slash", name: "help", authorized: true, body: "/help" },
      access: { commands: { authorized: true } },
      message: { rawBody: "/help", commandBody: "/help" },
    });
    if (scenario === "derived") {
      expect(ctx.SessionKey).not.toBe(route.sessionKey);
    }
    const adopted = vi.fn(async () => {});
    const settled = getReplyFromConfig(
      ctx,
      { turnAdoptionLifecycle: { onAdopted: adopted, onAbandoned: () => {} } },
      cfg,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    await Promise.race([entered.promise, settled]);
    current =
      stale && current
        ? { ...current, boundAt: current.boundAt + 1 }
        : { ...binding("global", conversation.conversationId), metadata: { agentId: "work" } };
    release.resolve();
    expect(await settled).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
    expect(read).toHaveBeenCalledWith(expect.objectContaining(conversation));
    expect(adopted).not.toHaveBeenCalled();
    expect(existsSync(mainWorkspace)).toBe(false);
    expect(existsSync(workWorkspace)).toBe(false);
  },
);
