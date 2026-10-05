import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackEventScope } from "../event-scope.js";
import { resolveSlackRoutingContext } from "./prepare-routing.js";
import { createSlackTestAccount } from "./prepare.test-helpers.js";

type RouteOptions = Parameters<typeof resolveSlackRoutingContext>[0];
function fixture(
  replyToMode: "all" | "off" = "all",
  dmScope: "main" | "per-channel-peer" = "main",
) {
  const ctx = {
    cfg: {
      session: { dmScope },
      channels: { slack: { enabled: true, replyToMode } },
    } satisfies OpenClawConfig,
    teamId: "T1",
    threadInheritParent: false,
    threadHistoryScope: "thread",
  } satisfies RouteOptions["ctx"];
  const account = createSlackTestAccount({ replyToMode });
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
  it("keeps ordinary top-level channel messages on one session when replies are threaded", () => {
    const { route } = fixture();
    expect(route().sessionKey).toBe("agent:main:slack:channel:c123");
    expect(route({ ts: "1770408531.000000" }).sessionKey).toBe("agent:main:slack:channel:c123");
  });

  it("keeps unseeded self-thread room roots on the channel session with replies off", () => {
    const { route } = fixture("off");
    const result = route({ thread_ts: "1770408530.000000" });
    expect(result.sessionKey).toBe("agent:main:slack:channel:c123");
    expect(result.threadContext.messageThreadId).toBeUndefined();
    expect(result.threadContext.replyToId).toBeUndefined();
  });

  it("keeps mentioned MPIM roots flat and routes follow-ups by their parent thread", () => {
    const { route } = fixture();
    const message = {
      channel: "G123",
      channel_type: "mpim",
      text: "<@B1> send a subagent",
    } satisfies Partial<SlackMessageEvent>;
    const options = { chatType: "group" } as const;
    const root = route(message, { ...options, seedTopLevelRoomThread: true });
    const followUp = route(
      {
        ...message,
        ts: "1770408540.000000",
        thread_ts: "1770408530.000000",
        parent_user_id: "U3",
        text: "what did you find?",
      },
      options,
    );
    expect(root.sessionKey).toBe("agent:main:slack:group:g123");
    expect(root.threadContext.replyToId).toBeUndefined();
    expect(root.threadContext.messageThreadId).toBe("1770408530.000000");
    expect(followUp.sessionKey).toBe("agent:main:slack:group:g123:thread:1770408530.000000");
    expect(followUp.threadContext.replyToId).toBe("1770408530.000000");
    expect(followUp.threadContext.messageThreadId).toBe("1770408530.000000");
  });

  it("keeps top-level DM sessions stable across delivery threads", () => {
    const { direct } = fixture("all", "per-channel-peer");
    const first = direct();
    const second = direct({ ts: "1770408531.000000" });
    expect(first.sessionKey).toBe("agent:main:slack:direct:u3");
    expect(second.sessionKey).toBe(first.sessionKey);
    expect(first.threadContext.messageThreadId).toBe("1770408530.000000");
    expect(second.threadContext.messageThreadId).toBe("1770408531.000000");
  });

  it("partitions enterprise main DM sessions by account and workspace", () => {
    const { direct } = fixture();
    const scope = (teamId: string): SlackEventScope => ({
      teamId,
      client: {} as SlackEventScope["client"],
    });
    const first = direct({}, scope("T111"));
    const second = direct({}, scope("T222"));
    expect(first.sessionKey).toBe("agent:main:main:account:default:team:t111");
    expect(first.route.mainSessionKey).toBe(first.sessionKey);
    expect(second.sessionKey).toBe("agent:main:main:account:default:team:t222");
    expect(second.route.mainSessionKey).toBe(second.sessionKey);
  });

  it.each(["thread", "base"])(
    "routes DM replies through explicit %s conversation bindings",
    (scope) => {
      const binding: SessionBindingRecord = {
        bindingId: "test-slack-dm-thread-binding",
        targetSessionKey: "agent:review:acp:session-slack-dm",
        targetKind: "session",
        status: "active",
        boundAt: 1,
        metadata: {},
        conversation: {
          channel: "slack",
          accountId: "default",
          conversationId: scope === "thread" ? "1770408530.000000" : "user:U3",
          parentConversationId: scope === "thread" ? "user:U3" : undefined,
        },
      };
      const resolveByConversation: SessionBindingAdapter["resolveByConversation"] = vi.fn((ref) =>
        ref.channel === "slack" &&
        ref.accountId === "default" &&
        ref.conversationId === binding.conversation.conversationId &&
        ref.parentConversationId === binding.conversation.parentConversationId
          ? binding
          : null,
      );
      const touch = vi.fn();
      const adapter: SessionBindingAdapter = {
        channel: "slack",
        accountId: "default",
        listBySession: () => [],
        resolveByConversation,
        touch,
      };
      registerSessionBindingAdapter(adapter);
      try {
        const { ctx, direct } = fixture("all", "per-channel-peer");
        const cfg: OpenClawConfig = ctx.cfg;
        cfg.agents = { ownership: "explicit", entries: { main: {}, review: {} } };
        const result = direct({
          ts: "1770408540.000000",
          thread_ts: "1770408530.000000",
          parent_user_id: "B1",
        });
        expect(result.sessionKey).toBe(binding.targetSessionKey);
        expect(result.runtimeBoundSessionKey).toBe(binding.targetSessionKey);
        expect(resolveByConversation).toHaveBeenCalledWith(binding.conversation);
        expect(touch).toHaveBeenCalledWith(binding.bindingId, undefined);
      } finally {
        unregisterSessionBindingAdapter({ channel: "slack", accountId: "default", adapter });
      }
    },
  );

  it("preserves distinct assistant DM root thread IDs despite missing or incorrect channel types", () => {
    const { direct } = fixture("off", "per-channel-peer");
    const first = direct({ channel_type: "channel", thread_ts: "1770408530.000000" });
    const second = direct({
      channel_type: undefined,
      ts: "1770408531.000000",
      thread_ts: "1770408531.000000",
    });
    expect(first.sessionKey).toBe("agent:main:slack:direct:u3");
    expect(second.sessionKey).toBe(first.sessionKey);
    expect(first.threadContext.messageThreadId).toBe("1770408530.000000");
    expect(second.threadContext.messageThreadId).toBe("1770408531.000000");
  });
});
