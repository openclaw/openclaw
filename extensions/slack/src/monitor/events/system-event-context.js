import { logVerbose } from "../../../../../src/globals.js";
import { authorizeSlackSystemEventSender } from "../auth.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
async function authorizeAndResolveSlackSystemEventContext(params) {
  const { ctx, senderId, channelId, channelType, eventKind } = params;
  const auth = await authorizeSlackSystemEventSender({
    ctx,
    senderId,
    channelId,
    channelType
  });
  if (!auth.allowed) {
    logVerbose(
      `slack: drop ${eventKind} sender ${senderId ?? "unknown"} channel=${channelId ?? "unknown"} reason=${auth.reason ?? "unauthorized"}`
    );
    return void 0;
  }
  const channelLabel = resolveSlackChannelLabel({
    channelId,
    channelName: auth.channelName
  });
  const sessionKey = ctx.resolveSlackSystemEventSessionKey({
    channelId,
    channelType: auth.channelType,
    senderId
  });
  return {
    channelLabel,
    sessionKey
  };
}
export {
  authorizeAndResolveSlackSystemEventContext
};
