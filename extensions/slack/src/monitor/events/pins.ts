// Slack plugin module implements pins behavior.
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import type { SlackMonitorContext } from "../context.js";
import type { SlackPinEvent } from "../types.js";
import {
  authorizeAndResolveSlackSystemEventContext,
  handleSlackSystemEventFailure,
  resolveSlackSystemEventOccurrenceId,
} from "./system-event-context.js";

async function handleSlackPinEvent(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
  body: unknown;
  context: unknown;
  event: unknown;
  action: "pinned" | "unpinned";
  contextKeySuffix: "added" | "removed";
  errorLabel: string;
}): Promise<void> {
  const { ctx, trackEvent, body, context, event, action, contextKeySuffix, errorLabel } = params;

  try {
    if (ctx.shouldDropMismatchedSlackEvent(body)) {
      return;
    }
    trackEvent?.();

    const payload = event as SlackPinEvent;
    const channelId = payload.channel_id;
    const ingressContext = await authorizeAndResolveSlackSystemEventContext({
      ctx,
      senderId: payload.user,
      channelId,
      eventKind: "pin",
    });
    if (!ingressContext) {
      return;
    }
    const userInfo = payload.user ? await ctx.resolveUserName(payload.user) : {};
    const userLabel = userInfo?.name ?? payload.user ?? "someone";
    const itemType = payload.item?.type ?? "item";
    const messageId = payload.item?.message?.ts ?? payload.event_ts;
    const occurrenceId = resolveSlackSystemEventOccurrenceId({
      body,
      eventTs: payload.event_ts,
    });
    enqueueSystemEvent(
      `Slack: ${userLabel} ${action} a ${itemType} in ${ingressContext.channelLabel}.`,
      {
        sessionKey: ingressContext.sessionKey,
        contextKey: `slack:pin:${contextKeySuffix}:${channelId ?? "unknown"}:${messageId ?? "unknown"}:${occurrenceId}`,
      },
    );
  } catch (err) {
    handleSlackSystemEventFailure({ ctx, context, error: err, label: errorLabel });
  }
}

export function registerSlackPinEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  ctx.app.event(
    "pin_added",
    async (args: SlackEventMiddlewareArgs<"pin_added"> & AllMiddlewareArgs) => {
      const { event, body, context } = args;
      await handleSlackPinEvent({
        ctx,
        trackEvent,
        body,
        context,
        event,
        action: "pinned",
        contextKeySuffix: "added",
        errorLabel: "pin added",
      });
    },
  );

  ctx.app.event(
    "pin_removed",
    async (args: SlackEventMiddlewareArgs<"pin_removed"> & AllMiddlewareArgs) => {
      const { event, body, context } = args;
      await handleSlackPinEvent({
        ctx,
        trackEvent,
        body,
        context,
        event,
        action: "unpinned",
        contextKeySuffix: "removed",
        errorLabel: "pin removed",
      });
    },
  );
}
