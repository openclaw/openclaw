// Slack plugin module implements reactions behavior.
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { allowListMatches, normalizeAllowListLower } from "../allow-list.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackReactionEvent } from "../types.js";
import {
  authorizeAndResolveSlackSystemEventContext,
  handleSlackSystemEventFailure,
  resolveSlackSystemEventOccurrenceId,
} from "./system-event-context.js";

function shouldEmitSlackReactionNotification(params: {
  ctx: SlackMonitorContext;
  event: SlackReactionEvent;
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

  const handleReactionEvent = async (paramsLocal: {
    event: SlackReactionEvent;
    action: "added" | "removed";
    body: unknown;
    context: unknown;
  }) => {
    try {
      const { event, action } = paramsLocal;
      const item = event.item;
      if (!item || item.type !== "message") {
        return;
      }
      if (ctx.reactionMode === "off") {
        return;
      }
      if (ctx.reactionMode === "own" && (!ctx.botUserId || event.item_user !== ctx.botUserId)) {
        return;
      }
      trackEvent?.();

      const ingressContext = await authorizeAndResolveSlackSystemEventContext({
        ctx,
        senderId: event.user,
        channelId: item.channel,
        eventKind: "reaction",
      });
      if (!ingressContext) {
        return;
      }

      const actorInfoPromise: Promise<{ name?: string } | undefined> = event.user
        ? ctx.resolveUserName(event.user)
        : Promise.resolve(undefined);
      const authorInfoPromise: Promise<{ name?: string } | undefined> = event.item_user
        ? ctx.resolveUserName(event.item_user)
        : Promise.resolve(undefined);
      const [actorInfo, authorInfo] = await Promise.all([actorInfoPromise, authorInfoPromise]);
      if (
        !shouldEmitSlackReactionNotification({
          ctx,
          event,
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
      const occurrenceId = resolveSlackSystemEventOccurrenceId({
        body: paramsLocal.body,
        eventTs: event.event_ts,
      });
      enqueueSystemEvent(text, {
        sessionKey: ingressContext.sessionKey,
        contextKey: `slack:reaction:${action}:${item.channel}:${item.ts}:${event.user}:${emojiLabel}:${occurrenceId}`,
      });
    } catch (err) {
      handleSlackSystemEventFailure({
        ctx,
        context: paramsLocal.context,
        error: err,
        label: "reaction",
      });
    }
  };

  ctx.app.event(
    "reaction_added",
    async ({
      event,
      body,
      context,
    }: SlackEventMiddlewareArgs<"reaction_added"> & AllMiddlewareArgs) => {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      await handleReactionEvent({
        event: event as SlackReactionEvent,
        action: "added",
        body,
        context,
      });
    },
  );

  ctx.app.event(
    "reaction_removed",
    async ({
      event,
      body,
      context,
    }: SlackEventMiddlewareArgs<"reaction_removed"> & AllMiddlewareArgs) => {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      await handleReactionEvent({
        event: event as SlackReactionEvent,
        action: "removed",
        body,
        context,
      });
    },
  );
}
