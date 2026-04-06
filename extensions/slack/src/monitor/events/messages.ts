import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/infra-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { SlackAppMentionEvent, SlackMessageEvent } from "../../types.js";
import { normalizeSlackChannelType } from "../channel-type.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";
import type { SlackMessageChangedEvent, SlackMessageDeletedEvent } from "../types.js";
import { resolveSlackMessageSubtypeHandler } from "./message-subtype-handlers.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

function isSelfAuthoredSlackMessageEvent(
  message: SlackMessageEvent,
  botUserId: string,
  botId: string,
): boolean {
  if (!botUserId && !botId) {
    return false;
  }

  // message_deleted: identity lives under previous_message, not top-level.
  if (message.subtype === "message_deleted") {
    const deleted = message as SlackMessageDeletedEvent;
    const user = deleted.previous_message?.user;
    const msgBotId = deleted.previous_message?.bot_id;
    return (
      (Boolean(botUserId) && user === botUserId) ||
      (Boolean(botId) && msgBotId === botId)
    );
  }

  // message_changed: prefer edited.user, fall back to nested message author.
  if (message.subtype === "message_changed") {
    const changed = message as SlackMessageChangedEvent & {
      message?: { edited?: { user?: string }; user?: string; bot_id?: string };
      previous_message?: { edited?: { user?: string }; user?: string; bot_id?: string };
    };
    const editorUserId = changed.message?.edited?.user ?? changed.previous_message?.edited?.user;
    if (editorUserId) {
      return editorUserId === botUserId;
    }
    // Fall back to nested message author fields (not top-level message.user).
    const user = changed.message?.user ?? changed.previous_message?.user;
    const msgBotId = changed.message?.bot_id ?? changed.previous_message?.bot_id;
    return (
      (Boolean(botUserId) && user === botUserId) ||
      (Boolean(botId) && msgBotId === botId)
    );
  }

  // Default: check top-level user/bot_id for regular messages and other subtypes.
  // With ignoreSelf disabled on Bolt, this is the only gate preventing message
  // loops from the bot's own outbound messages.
  return (
    (Boolean(botUserId) && message.user === botUserId) ||
    (Boolean(botId) && message.bot_id === botId)
  );
}

export function registerSlackMessageEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
}) {
  const { ctx, handleSlackMessage } = params;

  const handleIncomingMessageEvent = async ({ event, body }: { event: unknown; body: unknown }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }

      const message = event as SlackMessageEvent;
      if (isSelfAuthoredSlackMessageEvent(message, ctx.botUserId, ctx.botId)) {
        return;
      }
      const subtypeHandler = resolveSlackMessageSubtypeHandler(message);
      if (subtypeHandler) {
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
        return;
      }

      const mention = event as SlackAppMentionEvent;

      // With ignoreSelf disabled on Bolt, app_mention events from the bot's own
      // messages (e.g. echoed content that @-mentions itself) must be filtered
      // to prevent self-triggered reply loops.
      if (
        (ctx.botUserId && mention.user === ctx.botUserId) ||
        (ctx.botId && (mention as unknown as { bot_id?: string }).bot_id === ctx.botId)
      ) {
        return;
      }

      // Skip app_mention for DMs - they're already handled by message.im event
      // This prevents duplicate processing when both message and app_mention fire for DMs
      const channelType = normalizeSlackChannelType(mention.channel_type, mention.channel);
      if (channelType === "im" || channelType === "mpim") {
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
