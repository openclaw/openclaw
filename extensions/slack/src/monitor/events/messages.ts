import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/infra-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { SlackAppMentionEvent, SlackMessageEvent } from "../../types.js";
import { normalizeSlackChannelType } from "../channel-type.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";
import { resolveSlackMessageSubtypeHandler } from "./message-subtype-handlers.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

export function registerSlackMessageEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
}) {
  const { ctx, handleSlackMessage } = params;

  const handleIncomingMessageEvent = async ({ event, body }: { event: unknown; body: unknown }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        console.error("[slack-trace] drop mismatched message event before handler");
        return;
      }

      const message = event as SlackMessageEvent;
      console.error(
        `[slack-trace] ingress source=message channel=${message.channel} ts=${message.ts ?? "-"} thread_ts=${message.thread_ts ?? "-"} subtype=${message.subtype ?? "-"} user=${message.user ?? "-"} bot_id=${message.bot_id ?? "-"} text=${JSON.stringify(message.text ?? "")}`,
      );
      const subtypeHandler = resolveSlackMessageSubtypeHandler(message);
      if (subtypeHandler) {
        console.error(
          `[slack-trace] ingress source=message subtype-handler eventKind=${subtypeHandler.eventKind} channel=${message.channel} ts=${message.ts ?? "-"}`,
        );
        const channelId = subtypeHandler.resolveChannelId(message);
        const ingressContext = await authorizeAndResolveSlackSystemEventContext({
          ctx,
          senderId: subtypeHandler.resolveSenderId(message),
          channelId,
          channelType: subtypeHandler.resolveChannelType(message),
          eventKind: subtypeHandler.eventKind,
        });
        if (!ingressContext) {
          return;
        }
        enqueueSystemEvent(subtypeHandler.describe(ingressContext.channelLabel), {
          sessionKey: ingressContext.sessionKey,
          contextKey: subtypeHandler.contextKey(message),
        });
        return;
      }

      await handleSlackMessage(message, { source: "message" });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack handler failed: ${String(err)}`));
    }
  };

  // NOTE: Slack Event Subscriptions use names like "message.channels" and
  // "message.groups" to control *which* message events are delivered, but the
  // actual event payload always arrives with `type: "message"`.  The
  // `channel_type` field ("channel" | "group" | "im" | "mpim") distinguishes
  // the source.  Bolt rejects `app.event("message.channels")` since v4.6
  // because it is a subscription label, not a valid event type.
  ctx.app.event("message", async ({ event, body }: SlackEventMiddlewareArgs<"message">) => {
    await handleIncomingMessageEvent({ event, body });
  });

  ctx.app.event("app_mention", async ({ event, body }: SlackEventMiddlewareArgs<"app_mention">) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        console.error("[slack-trace] drop mismatched app_mention event before handler");
        return;
      }

      const mention = event as SlackAppMentionEvent;
      console.error(
        `[slack-trace] ingress source=app_mention channel=${mention.channel} ts=${mention.ts ?? "-"} thread_ts=${mention.thread_ts ?? "-"} user=${mention.user ?? "-"} text=${JSON.stringify(mention.text ?? "")}`,
      );

      // Skip app_mention for DMs - they're already handled by message.im event
      // This prevents duplicate processing when both message and app_mention fire for DMs
      const channelType = normalizeSlackChannelType(mention.channel_type, mention.channel);
      if (channelType === "im" || channelType === "mpim") {
        console.error(
          `[slack-trace] drop source=app_mention reason=dm-or-mpim channel=${mention.channel} ts=${mention.ts ?? "-"}`,
        );
        return;
      }

      await handleSlackMessage(mention as unknown as SlackMessageEvent, {
        source: "app_mention",
        wasMentioned: true,
      });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack mention handler failed: ${String(err)}`));
    }
  });
}
