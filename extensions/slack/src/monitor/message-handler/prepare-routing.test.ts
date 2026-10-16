import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  createTestRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "../../channel.js";
import { installSlackTestRuntime } from "../../test-runtime.test-support.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackEventScope } from "../event-scope.js";
import { resolveSlackRoutingContext } from "./prepare-routing.js";
import { createSlackTestAccount as createSlackAccount } from "./prepare.test-helpers.js";

beforeEach(() => {
  installSlackTestRuntime();
});

type RouteOptions = Parameters<typeof resolveSlackRoutingContext>[0];
function routingFixture(
  dmScope: "main" | "per-channel-peer" = "main",
  replyToMode: "off" | "first" | "all" | "batched" = "all",
) {
  const ctx = {
    cfg: {
      session: { dmScope },
      channels: { slack: { enabled: true, replyToMode } },
    } as OpenClawConfig,
    teamId: "T1",
    threadInheritParent: false,
    threadHistoryScope: "thread",
  } satisfies RouteOptions["ctx"];
  const account = createSlackAccount({ replyToMode });
  const route = (
    message: Partial<SlackMessageEvent> = {},
    options: Partial<Omit<RouteOptions, "ctx" | "account" | "message">> = {},
  ) =>
    resolveSlackRoutingContext({
      ctx,
      account,
      message: {
        type: "message",
        channel: "C123",
        channel_type: "channel",
        user: "U3",
        text: "hello",
        ts: "1770408530.000000",
        ...message,
      },
      chatType: "channel",
      ...options,
    });
  const direct = (message: Partial<SlackMessageEvent> = {}, eventScope?: SlackEventScope) =>
    route({ channel: "D456", channel_type: "im", ...message }, { chatType: "direct", eventScope });
  return { ctx, route, direct };
}

describe("thread-level session keys", () => {
  it.each(
    (["off", "first", "all", "batched"] as const).flatMap((mode) =>
      (["channel", "group"] as const).map((chatType) => ({ mode, chatType })),
    ),
  )(
    "keeps $mode $chatType roots flat and native replies on their parent thread",
    async ({ mode, chatType }) => {
      const { route } = routingFixture("main", mode);
      const channel = chatType === "group" ? "G123" : "C123";
      const channel_type = chatType === "group" ? "mpim" : "channel";
      const rootTs = "1777244692.409919";
      const baseKey = "agent:main:slack:" + chatType + ":" + channel.toLowerCase();
      for (const selfThread of [false, true]) {
        const root = await route(
          { channel, channel_type, ts: rootTs, thread_ts: selfThread ? rootTs : undefined },
          { chatType },
        );
        expect(root.sessionKey).toBe(baseKey);
        expect(root.threadContext.replyToId).toBeUndefined();
        expect(root.threadContext.messageThreadId).toBe(mode === "all" ? rootTs : undefined);
      }
      const child = await route(
        { channel, channel_type, ts: "1777244714.000100", thread_ts: rootTs, parent_user_id: "U1" },
        { chatType },
      );
      expect(child.sessionKey).toBe(baseKey + ":thread:" + rootTs);
      expect(child.threadContext.replyToId).toBe(rootTs);
      expect(child.threadContext.messageThreadId).toBe(rootTs);
    },
  );

  it.each([
    { name: "channel root", channel: "C123", chatType: "channel" as const, mode: "off" as const },
    {
      name: "channel thread",
      channel: "C123",
      chatType: "channel" as const,
      mode: "all" as const,
      threadTs: "1770408518.451689",
    },
    {
      name: "MPIM thread",
      channel: "G123",
      chatType: "group" as const,
      mode: "all" as const,
      threadTs: "1777244692.409919",
    },
  ])(
    "keeps the actual configured ACP $name target without a Slack thread suffix",
    async ({ channel, chatType, mode, threadTs }) => {
      const previousRegistry = getActivePluginRegistry();
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackPlugin }]),
      );
      try {
        const { ctx, route } = routingFixture("main", mode);
        ctx.cfg.agents = { ownership: "explicit", entries: { main: {}, review: {} } };
        ctx.cfg.bindings = [
          { agentId: "main", match: { channel: "slack", accountId: "default" } },
          {
            type: "acp",
            agentId: "review",
            match: {
              channel: "slack",
              accountId: "default",
              peer: { kind: chatType, id: channel },
            },
          },
        ];
        const selected = await route(
          { channel, channel_type: chatType === "group" ? "mpim" : "channel", thread_ts: threadTs },
          { chatType },
        );
        expect(selected.configuredBinding).not.toBeNull();
        const target = selected.configuredBinding!.record.targetSessionKey;
        expect(target).toMatch(/^agent:review:acp:/);
        expect(selected.route.agentId).toBe("review");
        expect(selected.route.sessionKey).toBe(target);
        expect(selected.sessionKey).toBe(target);
        expect(selected.configuredBindingSessionKey).toBe(target);
        expect(selected.sessionKey).not.toContain(":thread:");
        expect(selected.runtimeBinding).toBeNull();
      } finally {
        if (previousRegistry) {
          setActivePluginRegistry(previousRegistry);
        } else {
          resetPluginRuntimeStateForTest();
        }
      }
    },
  );

  it("routes a DM native thread through its exact runtime child binding and settles activity", async () => {
    const targetSessionKey = "agent:review:acp:session-slack-dm";
    const conversation = {
      channel: "slack",
      accountId: "default",
      conversationId: "1770408530.000000",
      parentConversationId: "user:U3",
    };
    const binding: SessionBindingRecord = {
      bindingId: "test-slack-dm-thread-binding",
      targetSessionKey,
      targetKind: "session",
      conversation,
      status: "active",
      boundAt: 1,
      metadata: {},
    };
    const read = vi.fn(
      async (ref: Parameters<SessionBindingAdapter["resolveByConversation"]>[0]) =>
        ref.conversationId === conversation.conversationId &&
        ref.parentConversationId === conversation.parentConversationId
          ? binding
          : null,
    );
    const touchAsync = vi.fn(async () => {});
    const adapter: SessionBindingAdapter = {
      channel: "slack",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => null,
      inspectByConversationAsync: read,
      resolveByConversationAsync: read,
      touchAsync,
    };
    registerSessionBindingAdapter(adapter);
    try {
      const { direct } = routingFixture("per-channel-peer");
      const selected = await direct({
        ts: "1770408540.000000",
        thread_ts: conversation.conversationId,
        parent_user_id: "B1",
      });
      expect(selected.sessionKey).toBe(targetSessionKey);
      expect(selected.runtimeBoundSessionKey).toBe(targetSessionKey);
      expect(read).toHaveBeenCalledWith(conversation);
      expect(touchAsync).toHaveBeenCalledWith(binding.bindingId, undefined);
    } finally {
      unregisterSessionBindingAdapter({ channel: "slack", accountId: "default", adapter });
    }
  });

  it("partitions enterprise main DM sessions by account and workspace", async () => {
    const { direct } = routingFixture();
    const scope = (teamId: string): SlackEventScope => ({
      teamId,
      client: {} as SlackEventScope["client"],
    });
    const first = await direct({}, scope("T111"));
    const second = await direct({}, scope("T222"));
    expect(first.sessionKey).toBe("agent:main:main:account:default:team:t111");
    expect(first.route.mainSessionKey).toBe(first.sessionKey);
    expect(second.sessionKey).toBe("agent:main:main:account:default:team:t222");
    expect(second.route.mainSessionKey).toBe(second.sessionKey);
  });
});
