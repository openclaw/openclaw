import { danger } from "../../../../../src/globals.js";
import { enqueueSystemEvent } from "../../../../../src/infra/system-events.js";
import { normalizeSlackChannelType } from "../channel-type.js";
import { resolveSlackMessageSubtypeHandler } from "./message-subtype-handlers.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";
function registerSlackMessageEvents(params) {
  const { ctx, handleSlackMessage } = params;
  const handleIncomingMessageEvent = async ({ event, body }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      const message = event;
      const subtypeHandler = resolveSlackMessageSubtypeHandler(message);
      if (subtypeHandler) {
        const channelId = subtypeHandler.resolveChannelId(message);
        const ingressContext = await authorizeAndResolveSlackSystemEventContext({
          ctx,
          senderId: subtypeHandler.resolveSenderId(message),
          channelId,
          channelType: subtypeHandler.resolveChannelType(message),
          eventKind: subtypeHandler.eventKind
        });
        if (!ingressContext) {
          return;
        }
        enqueueSystemEvent(subtypeHandler.describe(ingressContext.channelLabel), {
          sessionKey: ingressContext.sessionKey,
          contextKey: subtypeHandler.contextKey(message)
        });
        return;
      }
      await handleSlackMessage(message, { source: "message" });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack handler failed: ${String(err)}`));
    }
  };
  ctx.app.event("message", async ({ event, body }) => {
    await handleIncomingMessageEvent({ event, body });
  });
  ctx.app.event("app_mention", async ({ event, body }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      const mention = event;
      const channelType = normalizeSlackChannelType(mention.channel_type, mention.channel);
      if (channelType === "im" || channelType === "mpim") {
        return;
      }
      await handleSlackMessage(mention, {
        source: "app_mention",
        wasMentioned: true
      });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack mention handler failed: ${String(err)}`));
    }
  });
}
export {
  registerSlackMessageEvents
};
