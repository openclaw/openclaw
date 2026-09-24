import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { resolveSlackReplyToMode } from "../../account-reply-mode.js";
import { resolveSlackAccount } from "../../accounts.js";
import { allowListMatches, normalizeAllowListLower } from "../allow-list.js";
import { resolveSlackChannelConfig } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";
import { resolveSeededSlackRoomThreadId } from "../message-handler/prepare-routing.js";
import {
  isSlackSubteamMentionForBot,
  slackTextMentionsUser,
} from "../message-handler/subteam-mentions.js";
import { getSlackThreadTsResolver } from "../thread-resolution.js";
import type { SlackReactionEvent } from "../types.js";
import {
  authorizeAndResolveSlackSystemEventContext,
  resolveSlackListenerEventScope,
} from "./system-event-context.js";

function shouldEmitSlackReactionNotification(params: {
  ctx: SlackMonitorContext;
  event: SlackReactionEvent;
  eventScope?: SlackEventScope;
  actorName?: string;
}) {
  const { ctx, event, actorName } = params;
  if (ctx.reactionMode === "off") {
    return false;
  }
  if (ctx.reactionMode === "own") {
    return Boolean(ctx.botUserId && event.item_user === ctx.botUserId);
  }
  if (ctx.reactionMode === "allowlist") {
    const allowList = normalizeAllowListLower(ctx.reactionAllowlist);
    if (allowList.length === 0) {
      return false;
    }
    return allowListMatches({
      allowList,
      teamId: params.eventScope?.teamId ?? ctx.teamId,
      id: event.user,
      name: actorName,
      allowNameMatching: ctx.allowNameMatching,
    });
  }
  return ctx.reactionMode === "all";
}

export function registerSlackReactionEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;
  const resolveUserName = (userId: string, eventScope?: SlackEventScope) =>
    eventScope ? ctx.resolveUserName(userId, eventScope) : ctx.resolveUserName(userId);

  const handleReactionEvent = async (
    event: SlackReactionEvent,
    action: "added" | "removed",
    eventScope: SlackEventScope | undefined,
    eventId: string,
  ) => {
    try {
      const runtimeContext = await params.ctx.readRuntimeContext();
      const item = event.item;
      if (!item || item.type !== "message") {
        return;
      }
      if (runtimeContext.reactionMode === "off") {
        return;
      }
      if (
        runtimeContext.reactionMode === "own" &&
        (!runtimeContext.botUserId || event.item_user !== runtimeContext.botUserId)
      ) {
        return;
      }
      trackEvent?.();

      // Reaction-specific admission runs before sender authorization so a rejected
      // reaction never triggers the thread lookup's Slack reads below.
      const actorInfoPromise: Promise<{ name?: string } | undefined> = event.user
        ? resolveUserName(event.user, eventScope)
        : Promise.resolve(undefined);
      const authorInfoPromise: Promise<{ name?: string } | undefined> = event.item_user
        ? resolveUserName(event.item_user, eventScope)
        : Promise.resolve(undefined);
      const [actorInfo, authorInfo] = await Promise.all([actorInfoPromise, authorInfoPromise]);
      if (
        !shouldEmitSlackReactionNotification({
          ctx: runtimeContext,
          event,
          eventScope,
          actorName: actorInfo?.name,
        })
      ) {
        return;
      }

      const reactionClient = eventScope?.client ?? runtimeContext.app.client;
      const ingressContext = await authorizeAndResolveSlackSystemEventContext({
        ctx: runtimeContext,
        senderId: event.user,
        channelId: item.channel,
        eventKind: "reaction",
        eventScope,
        // A reaction payload names the reacted message but not its thread, so the
        // route would otherwise fall back to the parent channel session.
        ...(reactionClient
          ? {
              resolveThreadTs: async ({ channelType, channelName }) => {
                const isRoom = channelType === "channel" || channelType === "group";
                const account = resolveSlackAccount({
                  cfg: runtimeContext.cfg ?? {},
                  accountId: runtimeContext.accountId,
                });
                const channelConfig = isRoom
                  ? resolveSlackChannelConfig({
                      teamId: eventScope?.teamId ?? runtimeContext.teamId,
                      allowUnscoped: runtimeContext.installationIdentity?.kind !== "enterprise",
                      channelId: item.channel,
                      channelName,
                      channels: runtimeContext.channelsConfig,
                      channelKeys: runtimeContext.channelsConfigKeys,
                      defaultRequireMention: runtimeContext.defaultRequireMention,
                      allowNameMatching: runtimeContext.allowNameMatching,
                    })
                  : null;
                const replyToMode =
                  channelConfig?.replyToMode ?? resolveSlackReplyToMode(account, "channel");
                const requireMention =
                  channelConfig?.requireMention ?? runtimeContext.defaultRequireMention ?? true;
                return await getSlackThreadTsResolver(reactionClient).resolveThreadTs({
                  channelId: item.channel,
                  messageTs: item.ts,
                  // Root session ownership mirrors the inbound seeding decision: a
                  // mentioned or implicitly threaded root owns :thread:<root>; an
                  // unseeded root keeps the parent channel session even when Slack
                  // stamps thread_ts === ts on it.
                  resolveSeededRootThreadId: async (root) => {
                    const explicitlyMentioned =
                      slackTextMentionsUser(root.text, runtimeContext.botUserId) ||
                      (await isSlackSubteamMentionForBot({
                        client: reactionClient,
                        text: root.text,
                        botUserId: runtimeContext.botUserId,
                        teamId: eventScope?.teamId ?? runtimeContext.teamId,
                        log: logVerbose,
                      }));
                    return resolveSeededSlackRoomThreadId({
                      isThreadReply: false,
                      isRoom,
                      seedTopLevelRoomThread:
                        explicitlyMentioned || (isRoom && !requireMention && replyToMode !== "off"),
                      replyToMode,
                      candidateThreadId: root.threadTs ?? root.ts,
                    });
                  },
                });
              },
            }
          : {}),
      });
      if (!ingressContext) {
        return;
      }
      const actorLabel = actorInfo?.name ?? event.user;
      const emojiLabel = event.reaction ?? "emoji";
      const authorLabel = authorInfo?.name ?? event.item_user;
      const baseText = `Slack reaction ${action}: :${emojiLabel}: by ${actorLabel} in ${ingressContext.channelLabel} msg ${item.ts}`;
      const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
      enqueueRoutedSystemEvent(text, ingressContext.route, {
        contextKey: `slack:reaction:${eventScope ? `${eventScope.teamId}:` : ""}${action}:${item.channel}:${item.ts}:${event.user}:${emojiLabel}:${eventId}`,
      });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack reaction handler failed: ${formatErrorMessage(err)}`));
    }
  };

  for (const action of ["added", "removed"] as const) {
    ctx.app.event(
      `reaction_${action}`,
      async (
        args: SlackEventMiddlewareArgs<"reaction_added" | "reaction_removed"> & AllMiddlewareArgs,
      ) => {
        const { event, body, context, client } = args;
        const eventScope = resolveSlackListenerEventScope({ ctx, body, context, client });
        if (eventScope === null || ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }
        await handleReactionEvent(event as SlackReactionEvent, action, eventScope, body.event_id);
      },
    );
  }
}
