import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { expect, it, onTestFinished } from "vitest";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
} from "./message-handler.preflight.test-helpers.js";
import { resolveDiscordPreflightRoute } from "./message-handler.routing-preflight.js";

it.each(["default", "ambiguous", "stale", "main-session"])(
  "resolves conversation bindings with %s routing",
  async (routing) => {
    const channelId = "channel-bound";
    const binding: SessionBindingRecord = {
      bindingId: "default:channel-bound",
      targetSessionKey:
        routing === "stale"
          ? `agent:second:discord:channel:${channelId}`
          : routing === "main-session"
            ? "agent:second:home"
            : "agent:second:acp:bound-session",
      targetKind: "session",
      conversation: { channel: "discord", accountId: "default", conversationId: channelId },
      status: "active",
      boundAt: 1,
    };
    const adapter: SessionBindingAdapter = {
      channel: "discord",
      accountId: "default",
      listBySession: () => [binding],
      resolveByConversation: (ref) => (ref.conversationId === channelId ? binding : null),
    };
    const cfg: OpenClawConfig =
      routing === "ambiguous"
        ? { agents: { ownership: "explicit", entries: { first: {}, second: {} } } }
        : routing === "stale"
          ? { agents: { list: [{ id: "first" }] } }
          : routing === "main-session"
            ? {
                agents: { ownership: "explicit", entries: { first: {}, second: {} } },
                bindings: [{ agentId: "first", match: { channel: "discord" } }],
                session: { mainKey: "home" },
              }
            : {};
    const message = createDiscordMessage({
      id: "message-bound",
      channelId,
      content: "continue",
      author: { id: "user-1", bot: false },
    });
    const author = message.author;
    if (!author) {
      throw new Error("Expected a sender in the Discord fixture");
    }
    const preflight = createDiscordPreflightArgs({
      cfg,
      discordConfig: {},
      data: createGuildEvent({ channelId, guildId: "guild-1", author, message }),
      client: createGuildTextClient(channelId),
    });
    registerSessionBindingAdapter(adapter);
    onTestFinished(() =>
      unregisterSessionBindingAdapter({ channel: "discord", accountId: "default", adapter }),
    );
    const result = await resolveDiscordPreflightRoute({
      preflight,
      author,
      isDirectMessage: false,
      isGroupDm: false,
      messageChannelId: channelId,
      memberRoleIds: [],
    });
    expect(result.effectiveRoute.agentId).toBe(routing === "stale" ? "first" : "second");
    expect(result.baseSessionKey).toBe(
      routing === "stale" ? `agent:first:discord:channel:${channelId}` : binding.targetSessionKey,
    );
    expect(result.threadBinding).toEqual(routing === "stale" ? undefined : binding);
    if (routing === "main-session") {
      expect(result.effectiveRoute).toMatchObject({
        agentId: "second",
        sessionKey: "agent:second:home",
        mainSessionKey: "agent:second:home",
        lastRoutePolicy: "main",
      });
    }
  },
);
