import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { stripRoamTargetPrefix } from "./normalize.js";

/** Detect whether a raw target string refers to a DM (direct) or group chat. */
function resolveTargetKind(raw: string): "direct" | "group" {
  const trimmed = raw.trim().replace(/^(roam|roam-hq):/i, "");
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("dm:") || lower.startsWith("user:")) {
    return "direct";
  }
  return "group";
}

export function resolveRoamOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const chatId = stripRoamTargetPrefix(params.target);
  if (!chatId) {
    return null;
  }
  // Prefer resolved target kind from directory/normalization; fall back to prefix parsing.
  const resolvedKind = params.resolvedTarget?.kind;
  const kind: "direct" | "group" =
    resolvedKind === "user"
      ? "direct"
      : resolvedKind === "group" || resolvedKind === "channel"
        ? "group"
        : resolveTargetKind(params.target);
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
