// Slack plugin module implements members behavior.
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMemberChannelEvent } from "../types.js";
import {
  authorizeAndResolveSlackSystemEventContext,
  handleSlackSystemEventFailure,
  resolveSlackSystemEventOccurrenceId,
} from "./system-event-context.js";

export function registerSlackMemberEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  const handleMemberChannelEvent = async (paramsLocal: {
    verb: "joined" | "left";
    event: SlackMemberChannelEvent;
    body: unknown;
    context: AllMiddlewareArgs["context"];
  }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(paramsLocal.body)) {
        return;
      }
      trackEvent?.();
      const payload = paramsLocal.event;
      const channelId = payload.channel;
      const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
      const channelType = payload.channel_type ?? channelInfo?.type;
      const ingressContext = await authorizeAndResolveSlackSystemEventContext({
        ctx,
        senderId: payload.user,
        channelId,
        channelType,
        eventKind: `member-${paramsLocal.verb}`,
      });
      if (!ingressContext) {
        return;
      }
      const userInfo = payload.user ? await ctx.resolveUserName(payload.user) : {};
      const userLabel = userInfo?.name ?? payload.user ?? "someone";
      // Durable ingress owns retry dedupe by envelope event_id. Carry that same
      // logical occurrence into the prompt queue so a later join is not folded
      // into an earlier join for the same channel and user.
      const occurrenceId = resolveSlackSystemEventOccurrenceId({
        body: paramsLocal.body,
        eventTs: payload.event_ts,
      });
      enqueueSystemEvent(
        `Slack: ${userLabel} ${paramsLocal.verb} ${ingressContext.channelLabel}.`,
        {
          sessionKey: ingressContext.sessionKey,
          contextKey: `slack:member:${paramsLocal.verb}:${channelId ?? "unknown"}:${payload.user ?? "unknown"}:${occurrenceId}`,
        },
      );
    } catch (err) {
      handleSlackSystemEventFailure({
        ctx,
        context: paramsLocal.context,
        error: err,
        label: paramsLocal.verb,
      });
    }
  };

  ctx.app.event(
    "member_joined_channel",
    async ({
      event,
      body,
      context,
    }: SlackEventMiddlewareArgs<"member_joined_channel"> & AllMiddlewareArgs) => {
      await handleMemberChannelEvent({
        verb: "joined",
        event: event as SlackMemberChannelEvent,
        body,
        context,
      });
    },
  );

  ctx.app.event(
    "member_left_channel",
    async ({
      event,
      body,
      context,
    }: SlackEventMiddlewareArgs<"member_left_channel"> & AllMiddlewareArgs) => {
      await handleMemberChannelEvent({
        verb: "left",
        event: event as SlackMemberChannelEvent,
        body,
        context,
      });
    },
  );
}
