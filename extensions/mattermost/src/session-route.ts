// Mattermost plugin module implements session route behavior.
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { mattermostChannelKindCache } from "./mattermost/monitor-gating.js";

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
  // Only trust the monitor-populated cache for authoritative channel type.
  // A cold cache (undefined) preserves the existing "channel" default,
  // preventing uncached public channel: targets from being misclassified
  // as group. When the monitor has resolved the channel type, the cache
  // entry carries the authoritative Mattermost channel kind (D→direct,
  // G/P→group, O→channel).
  const cachedKind = mattermostChannelKindCache.get(rawId, params.accountId ?? undefined);
  const chatType = isUser ? "direct" : cachedKind === "group" ? "group" : "channel";
  // Align peer kind, from, and to with the resolved chatType so that
  // private-channel group routes share the same session-key namespace.
  const peerKind = isUser ? "direct" : cachedKind === "group" ? "group" : "channel";
  const baseRoute = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "mattermost",
    accountId: params.accountId,
    peer: {
      kind: peerKind,
      id: rawId,
    },
    chatType,
    from: isUser
      ? `mattermost:${rawId}`
      : peerKind === "group"
        ? `mattermost:group:${rawId}`
        : `mattermost:channel:${rawId}`,
    to: isUser ? `user:${rawId}` : peerKind === "group" ? `group:${rawId}` : `channel:${rawId}`,
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
