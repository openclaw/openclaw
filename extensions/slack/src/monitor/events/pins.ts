import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import type { SlackMonitorContext } from "../context.js";
import type { SlackPinEvent } from "../types.js";
import {
  authorizeAndResolveSlackSystemEventContext,
  resolveSlackListenerEventScope,
} from "./system-event-context.js";

export function registerSlackPinEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;
  for (const contextKeySuffix of ["added", "removed"] as const) {
    const action = contextKeySuffix === "added" ? "pinned" : "unpinned";
    ctx.app.event(
      `pin_${contextKeySuffix}`,
      async (args: SlackEventMiddlewareArgs<"pin_added" | "pin_removed"> & AllMiddlewareArgs) => {
        const { event, body, context, client } = args;
        try {
          const eventScope = resolveSlackListenerEventScope({ ctx, body, context, client });
          if (eventScope === null) {
            return;
          }
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
            eventScope,
          });
          if (!ingressContext) {
            return;
          }
          const userInfo = payload.user
            ? await (eventScope
                ? ctx.resolveUserName(payload.user, eventScope)
                : ctx.resolveUserName(payload.user))
            : {};
          const userLabel = userInfo?.name ?? payload.user ?? "someone";
          const itemType = payload.item?.type ?? "item";
          const messageId = payload.item?.message?.ts ?? payload.event_ts;
          enqueueRoutedSystemEvent(
            `Slack: ${userLabel} ${action} a ${itemType} in ${ingressContext.channelLabel}.`,
            ingressContext.route,
            {
              contextKey: `slack:pin:${eventScope ? `${eventScope.teamId}:` : ""}${contextKeySuffix}:${channelId ?? "unknown"}:${messageId ?? "unknown"}:${body.event_id}`,
            },
          );
        } catch (err) {
          ctx.runtime.error?.(
            danger(`slack pin ${contextKeySuffix} handler failed: ${formatErrorMessage(err)}`),
          );
        }
      },
    );
  }
}
