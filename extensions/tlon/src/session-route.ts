import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { parseTlonTarget } from "./targets.js";

export function resolveTlonOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const parsed = parseTlonTarget(params.target);
  if (!parsed) {
    return null;
  }
  const isGroup = parsed.kind === "group";
  const peerId = isGroup ? parsed.nest : parsed.ship;

  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "tlon",
    accountId: params.accountId,
    recipientSessionExact: true,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `tlon:group:${peerId}` : `tlon:${peerId}`,
    to: `tlon:${peerId}`,
  });
}
