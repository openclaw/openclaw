// Mattermost plugin module implements session route behavior.
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { peekMattermostChannelKind } from "./mattermost/channel-kind-store.js";

export function resolveMattermostOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  let trimmed = stripChannelTargetPrefix(params.target, "mattermost");
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const resolvedKind = params.resolvedTarget?.kind;
  const isUser =
    resolvedKind === "user" ||
    (resolvedKind !== "channel" &&
      resolvedKind !== "group" &&
      (lower.startsWith("user:") || trimmed.startsWith("@")));
  if (trimmed.startsWith("@")) {
    trimmed = trimmed.slice(1).trim();
  }
  const rawId = stripTargetKindPrefix(trimmed);
  if (!rawId) {
    return null;
  }
  // Prefer the monitor-backed cache kind over the potentially lossy resolvedTarget.kind
  // so that public channels that happen to carry a "group" resolved kind are not pulled
  // into the group session namespace.
  const cachedKind = peekMattermostChannelKind(rawId);
  const effectiveKind = cachedKind ?? resolvedKind;
  const isGroup = !isUser && effectiveKind === "group";
  const baseRoute = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "mattermost",
    accountId: params.accountId,
    peer: {
      kind: isUser ? "direct" : isGroup ? "group" : "channel",
      id: rawId,
    },
    chatType: isUser ? "direct" : isGroup ? "group" : "channel",
    from: isUser ? `mattermost:${rawId}` : `mattermost:channel:${rawId}`,
    to: isUser ? `user:${rawId}` : `channel:${rawId}`,
  });
  return buildThreadAwareOutboundSessionRoute({
    route: baseRoute,
    replyToId: params.replyToId,
    threadId: params.threadId,
    currentSessionKey: params.currentSessionKey,
    canRecoverCurrentThread: ({ route }) =>
      route.chatType !== "direct" || (params.cfg.session?.dmScope ?? "main") !== "main",
  });
}
