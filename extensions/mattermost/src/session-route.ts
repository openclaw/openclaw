// Mattermost plugin module implements session route behavior.
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

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
  // Honor an authoritative `group` kind (private channel / group DM, from the
  // directory resolver) instead of flattening every non-user target to
  // `channel`. The inbound path keys these under `group:<id>` via
  // mapMattermostChannelKind (P/G -> group); a `channel:<id>` outbound route
  // would split the same conversation across two session namespaces (#95646).
  // A bare `channel:<id>` with no resolved kind stays `channel` since the real
  // channel type is not knowable from the target string alone.
  const isGroup = !isUser && resolvedKind === "group";
  if (trimmed.startsWith("@")) {
    trimmed = trimmed.slice(1).trim();
  }
  const rawId = stripTargetKindPrefix(trimmed);
  if (!rawId) {
    return null;
  }
  const kind = isUser ? "direct" : isGroup ? "group" : "channel";
  const baseRoute = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "mattermost",
    accountId: params.accountId,
    peer: {
      kind,
      id: rawId,
    },
    chatType: kind,
    from: isUser ? `mattermost:${rawId}` : `mattermost:${kind}:${rawId}`,
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
