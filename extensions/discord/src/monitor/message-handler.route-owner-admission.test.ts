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
import { discordPlugin } from "../../channel-plugin-api.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
} from "./message-handler.preflight.test-helpers.js";
import { resolveDiscordPreflightRoute } from "./message-handler.routing-preflight.js";
import { resolveDiscordAutoThreadContext } from "./threading.js";

type Conversation = Parameters<SessionBindingAdapter["resolveByConversation"]>[0];
let state: OpenClawTestState;
let adapter: SessionBindingAdapter | undefined;
let stopThreadManager: (() => void) | undefined;
beforeAll(async () => {
  state = await createOpenClawTestState({
    label: "discord-route-owner-admission",
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
  if (adapter) {
    unregisterSessionBindingAdapter({ channel: "discord", accountId: "default", adapter });
    adapter = undefined;
  }
  stopThreadManager?.();
  stopThreadManager = undefined;
  resetPluginRuntimeStateForTest();
});

it.each([
  "none-to-global",
  "plugin-to-global",
  "plugin-stable",
  "configured-stable",
  "configured-race",
  "ignored-stale-stable",
  "ignored-stale-change",
  "derived-none-stable",
  "derived-none-to-global",
  "dm-none-stable",
  "dm-none-to-global",
] as const)("carries Discord routing into reply ownership validation: %s", async (scenario) => {
  const direct = scenario.startsWith("dm-");
  const channelId = direct ? "dm-channel-1" : "channel-1";
  const configured = scenario.startsWith("configured-");
  const ignoredStale = scenario.startsWith("ignored-stale-");
  const derived = scenario.startsWith("derived-");
  const changes =
    scenario.endsWith("to-global") || scenario.endsWith("race") || scenario.endsWith("change");
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
    session: { scope: ignoredStale || derived ? "per-sender" : "global" },
    channels: { discord: { enabled: true } },
    bindings: [
      {
        agentId: ignoredStale ? "work" : "main",
        match: { channel: "discord", accountId: "default" },
      },
      ...(configured
        ? [
            {
              type: "acp" as const,
              agentId: "work",
              match: {
                channel: "discord",
                accountId: "default",
                peer: { kind: "channel" as const, id: channelId },
              },
            },
          ]
        : []),
    ],
  };
  setRuntimeConfigSnapshot(cfg);
  const conversation: Conversation = {
    channel: "discord",
    accountId: "default",
    conversationId: direct ? "user:user-1" : channelId,
  };
  const replacement: SessionBindingRecord = {
    bindingId: "new-global",
    targetSessionKey: "global",
    targetKind: "session",
    status: "active",
    boundAt: 2,
    conversation,
    metadata: { agentId: "work" },
  };
  let current: SessionBindingRecord | null = ignoredStale
    ? {
        ...replacement,
        bindingId: "implicit-old-route",
        boundAt: 1,
        targetSessionKey: `agent:main:discord:channel:${channelId}`,
        metadata: undefined,
      }
    : scenario.startsWith("plugin-")
      ? {
          ...replacement,
          targetSessionKey: "plugin-binding:synthetic:source",
          metadata: {
            pluginBindingOwner: "plugin",
            pluginId: "synthetic",
            pluginRoot: state.path("plugin"),
          },
        }
      : null;

  const message = createDiscordMessage({
    id: scenario,
    channelId,
    content: "hello",
    author: { id: "user-1", username: "synthetic", bot: false },
  });
  const author = message.author;
  if (!author) {
    throw new Error("Expected a sender in the Discord fixture");
  }
  // The maintained fixture creates a live empty owner; register the proof owner afterward.
  const preflight = createDiscordPreflightArgs({
    cfg,
    discordConfig: cfg.channels?.discord,
    data: direct
      ? { channel_id: channelId, author, message }
      : createGuildEvent({ channelId, guildId: "guild-1", author, message }),
    client: createGuildTextClient(channelId),
  });
  stopThreadManager = () => preflight.threadBindings.stop();
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  let armed = false;
  let reached = false;
  const admissionReads: Conversation[] = [];
  const lookup = (ref: Conversation) =>
    ref.conversationId === conversation.conversationId ? current : null;
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
    channel: "discord",
    accountId: "default",
    listBySession: () => [],
    resolveByConversation: lookup,
    inspectByConversationAsync: read,
    resolveByConversationAsync: read,
    touchAsync: async () => {},
  };
  registerSessionBindingAdapter(adapter);
  const prepared = await resolveDiscordPreflightRoute({
    preflight,
    author,
    isDirectMessage: direct,
    isGroupDm: false,
    messageChannelId: channelId,
    memberRoleIds: [],
  });
  const route = prepared.effectiveRoute;
  expect(route.agentId).toBe(configured || ignoredStale ? "work" : "main");
  if (configured) {
    expect(route.sessionKey).toContain("agent:work:acp:");
  }
  if (ignoredStale) {
    expect(route.sessionKey).toBe(`agent:work:discord:channel:${channelId}`);
  }
  const autoThread = derived
    ? resolveDiscordAutoThreadContext({
        agentId: route.agentId,
        channel: "discord",
        parentSessionKey: route.sessionKey,
        createdThreadId: "new-thread",
      })
    : null;
  const ctx = buildChannelInboundEventContext({
    channel: "discord",
    accountId: "default",
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
  if (derived) {
    expect(ctx.SessionKey).not.toBe(route.sessionKey);
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
    current =
      scenario === "ignored-stale-change" && current
        ? { ...current, boundAt: current.boundAt + 1 }
        : replacement;
  }
  if (!changes) {
    abort.abort();
  }
  release.resolve();
  const outcome = await settled;
  expect(reached).toBe(true);
  expect(admissionReads).toContainEqual(expect.objectContaining(conversation));
  expect(outcome).toMatchObject(
    changes ? { code: "SESSION_WORK_START_CHANGED" } : { name: "AbortError" },
  );
  expect(adopted).not.toHaveBeenCalled();
  expect(existsSync(mainWorkspace)).toBe(false);
  expect(existsSync(workWorkspace)).toBe(false);
});
