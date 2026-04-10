import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { stripRoamTargetPrefix } from "./normalize.js";

/** Detect whether a raw target string refers to a DM (direct) or group chat. */
function resolveTargetKind(raw: string): "direct" | "group" {
  const trimmed = raw.trim().replace(/^(roam|roam-hq):/i, "");
  if (trimmed.startsWith("dm:") || trimmed.startsWith("user:")) {
    return "direct";
  }
  return "group";
}

export function resolveRoamOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const chatId = stripRoamTargetPrefix(params.target);
  if (!chatId) {
    return null;
  }
  const kind = resolveTargetKind(params.target);
  const isGroup = kind === "group";
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "roam",
    accountId: params.accountId,
    peer: {
      kind,
      id: chatId,
    },
    chatType: kind,
    from: isGroup ? `roam:group:${chatId}` : `roam:${chatId}`,
    to: `roam:${chatId}`,
  });
}
