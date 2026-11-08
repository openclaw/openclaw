import {
  buildChannelInboundEventContext,
  dispatchChannelInboundTurn,
} from "openclaw/plugin-sdk/channel-inbound";
import { bindIngressLifecycleToReplyOptions } from "openclaw/plugin-sdk/channel-outbound";
import type { DiscordIngressLifecycle } from "./ingress.js";
import type { DiscordReactionConversation } from "./listeners.reactions.js";
import { deliverDiscordReply } from "./reply-delivery.js";

/** Reuse ordinary channel turn admission, queueing, delivery and consumption. */
export async function dispatchDiscordReactionConversation(
  event: DiscordReactionConversation,
  options: { token: string; textLimit: number; lifecycle: DiscordIngressLifecycle },
): Promise<boolean> {
  const { cfg, context, route, assertAuthority } = event;
  const text = `Conversational reaction (not approval or task acceptance): ${JSON.stringify(context)}`;
  const target = `channel:${context.conversationId}`;
  const messageId = `reaction:${context.occurrenceId}`;
  const assertCurrent = () => {
    options.lifecycle.abortSignal.throwIfAborted();
    assertAuthority();
  };
  const ctxPayload = buildChannelInboundEventContext({
    channelIngress: "unsupported",
    channel: "discord",
    accountId: context.accountId,
    messageId,
    from: event.conversationKind === "direct" ? `discord:${context.actorId}` : target,
    sender: { id: context.actorId, roles: event.memberRoleIds },
    conversation: {
      kind: event.conversationKind,
      id: context.conversationId,
      nativeChannelId: context.conversationId,
      parentId: event.parentId,
      threadId: event.isThread ? context.conversationId : undefined,
      spaceId: event.guildId,
      routePeer: {
        kind: event.conversationKind,
        id: event.conversationKind === "direct" ? context.actorId : context.conversationId,
      },
    },
    route: {
      agentId: route.agentId,
      routeSessionKey: route.sessionKey,
      accountId: context.accountId,
    },
    reply: { to: target, originatingTo: target },
    message: {
      inboundEventKind: "room_event",
      body: text,
      bodyForAgent: text,
      rawBody: text,
      commandBody: text,
    },
    access: { commands: { authorized: false } },
    extra: { Reaction: context },
  });
  const result = await dispatchChannelInboundTurn({
    cfg,
    channel: "discord",
    accountId: context.accountId,
    route,
    ctxPayload,
    assertAuthority: assertCurrent,
    turnAdoptionLifecycle: options.lifecycle,
    replyOptions: bindIngressLifecycleToReplyOptions(options.lifecycle),
    sessionInitRetry: { delaysMs: [] },
    delivery: {
      deliver: async (payload, info) => {
        assertCurrent();
        return await deliverDiscordReply({
          cfg,
          replies: [payload],
          target,
          token: options.token,
          accountId: context.accountId,
          textLimit: options.textLimit,
          sessionKey: route.sessionKey,
          kind: info.kind,
        });
      },
      onError: (error) => {
        throw error;
      },
    },
    record: {
      onRecordError: (error) => {
        throw error;
      },
    },
    replyPipeline: {},
  });
  return result.dispatched;
}
