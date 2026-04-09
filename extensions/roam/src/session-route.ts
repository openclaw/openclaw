import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { stripRoamTargetPrefix } from "./normalize.js";

export function resolveRoamOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const chatId = stripRoamTargetPrefix(params.target);
  if (!chatId) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "roam",
    accountId: params.accountId,
    peer: {
      kind: "group",
      id: chatId,
    },
    chatType: "group",
    from: `roam:group:${chatId}`,
    to: `roam:${chatId}`,
  });
}
