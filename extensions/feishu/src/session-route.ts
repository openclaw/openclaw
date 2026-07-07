// Feishu plugin module implements session route behavior.
import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

function currentSessionIsFeishuGroupForTarget(params: {
  currentSessionKey?: string;
  target: string;
}): boolean {
  const sessionKey = normalizeLowercaseStringOrEmpty(params.currentSessionKey);
  const target = normalizeLowercaseStringOrEmpty(params.target);
  if (!sessionKey || !target) {
    return false;
  }
  const marker = `feishu:group:${target}`;
  const markerIndex = sessionKey.startsWith(marker) ? 0 : sessionKey.indexOf(`:${marker}`) + 1;
  if (markerIndex < 1 && !sessionKey.startsWith(marker)) {
    return false;
  }
  const suffix = sessionKey.slice(markerIndex + marker.length);
  return suffix === "" || suffix.startsWith(":");
}

export function resolveFeishuOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  let trimmed = stripChannelTargetPrefix(params.target, "feishu", "lark");
  if (!trimmed) {
    return null;
  }

  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  let isGroup = false;
  let typeExplicit = false;

  if (lower.startsWith("group:") || lower.startsWith("chat:") || lower.startsWith("channel:")) {
    trimmed = trimmed.replace(/^(group|chat|channel):/i, "").trim();
    isGroup = true;
    typeExplicit = true;
  } else if (lower.startsWith("user:") || lower.startsWith("dm:")) {
    trimmed = trimmed.replace(/^(user|dm):/i, "").trim();
    isGroup = false;
    typeExplicit = true;
  }

  if (!typeExplicit) {
    const idLower = normalizeLowercaseStringOrEmpty(trimmed);
    if (idLower.startsWith("ou_") || idLower.startsWith("on_")) {
      isGroup = false;
    } else if (
      (params.resolvedTarget?.kind === "group" && params.resolvedTarget.source === "directory") ||
      currentSessionIsFeishuGroupForTarget({
        currentSessionKey: params.currentSessionKey,
        target: trimmed,
      })
    ) {
      isGroup = true;
    }
  }

  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "feishu",
    accountId: params.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: trimmed,
    },
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `feishu:group:${trimmed}` : `feishu:${trimmed}`,
    to: trimmed,
  });
}
