import { danger } from "../../../../../src/globals.js";
import { enqueueSystemEvent } from "../../../../../src/infra/system-events.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";
function registerSlackMemberEvents(params) {
  const { ctx, trackEvent } = params;
  const handleMemberChannelEvent = async (params2) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(params2.body)) {
        return;
      }
      trackEvent?.();
      const payload = params2.event;
      const channelId = payload.channel;
      const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
      const channelType = payload.channel_type ?? channelInfo?.type;
      const ingressContext = await authorizeAndResolveSlackSystemEventContext({
        ctx,
        senderId: payload.user,
        channelId,
        channelType,
        eventKind: `member-${params2.verb}`
      });
      if (!ingressContext) {
        return;
      }
      const userInfo = payload.user ? await ctx.resolveUserName(payload.user) : {};
      const userLabel = userInfo?.name ?? payload.user ?? "someone";
      enqueueSystemEvent(`Slack: ${userLabel} ${params2.verb} ${ingressContext.channelLabel}.`, {
        sessionKey: ingressContext.sessionKey,
        contextKey: `slack:member:${params2.verb}:${channelId ?? "unknown"}:${payload.user ?? "unknown"}`
      });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack ${params2.verb} handler failed: ${String(err)}`));
    }
  };
  ctx.app.event(
    "member_joined_channel",
    async ({ event, body }) => {
      await handleMemberChannelEvent({
        verb: "joined",
        event,
        body
      });
    }
  );
  ctx.app.event(
    "member_left_channel",
    async ({ event, body }) => {
      await handleMemberChannelEvent({
        verb: "left",
        event,
        body
      });
    }
  );
}
export {
  registerSlackMemberEvents
};
