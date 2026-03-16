import { resolveOutboundSendDep, type OutboundSendDeps } from "openclaw/plugin-sdk/compat";
import {
  createScopedChannelMediaMaxBytesResolver,
  createDirectTextMediaOutbound,
} from "../../../src/channels/plugins/outbound/direct-text-media.js";
import { sendMessageIMessage } from "./send.js";

function resolveIMessageSender(deps: OutboundSendDeps | undefined) {
  return (
    resolveOutboundSendDep<typeof sendMessageIMessage>(deps, "imessage") ?? sendMessageIMessage
  );
}

export const imessageOutbound = createDirectTextMediaOutbound({
  channel: "imessage",
  resolveSender: resolveIMessageSender,
  resolveMaxBytes: createScopedChannelMediaMaxBytesResolver("imessage"),
  buildTextOptions: ({ cfg, maxBytes, accountId, replyToId }) => ({
    config: cfg,
    maxBytes,
    accountId: accountId ?? undefined,
    replyToId: replyToId ?? undefined,
  }),
  buildMediaOptions: ({ cfg, mediaUrl, maxBytes, accountId, replyToId, mediaLocalRoots }) => ({
    config: cfg,
    mediaUrl,
    maxBytes,
    accountId: accountId ?? undefined,
    replyToId: replyToId ?? undefined,
    mediaLocalRoots,
  }),
});
