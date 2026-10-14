import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeStringEntriesLower } from "openclaw/plugin-sdk/string-normalization-runtime";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { allowListMatches } from "../allow-list.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackMonitorEventScope } from "../event-scope.js";
import type { SlackEventScope } from "../event-scope.js";
import type { SlackReactionEvent } from "../types.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

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
    const allowList = normalizeStringEntriesLower(ctx.reactionAllowlist);
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

  for (const action of ["added", "removed"] as const) {
    ctx.app.event(
      `reaction_${action}`,
      async (
        args: SlackEventMiddlewareArgs<"reaction_added" | "reaction_removed"> & AllMiddlewareArgs,
      ) => {
        const { body, context, client } = args;
        const event = args.event as SlackReactionEvent;
        const eventScope = resolveSlackMonitorEventScope({ ctx, body, context, client });
        if (eventScope === null || ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }
        const eventId = body.event_id;
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

          const ingressContext = await authorizeAndResolveSlackSystemEventContext({
            ctx: runtimeContext,
            senderId: event.user,
            channelId: item.channel,
            eventKind: "reaction",
            eventScope,
          });
          if (!ingressContext) {
            return;
          }

          const [actorInfo, authorInfo] = await Promise.all(
            [event.user, event.item_user].map((userId) =>
              userId ? resolveUserName(userId, eventScope) : Promise.resolve(undefined),
            ),
          );
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
      },
    );
  }
}
