// Whatsapp plugin module implements session route behavior.
import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { resolveWhatsAppGroupSessionKey } from "./group-session-key.js";
import { resolveWhatsAppTargetFacts } from "./target-facts.js";

export function resolveWhatsAppOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const resolution = resolveWhatsAppTargetFacts({ target: params.target });
  if (!resolution.ok) {
    return null;
  }
  const facts = resolution.facts;
  const routeTarget = facts.wireDelivery.preserveJidAsAuthorizedTarget
    ? facts.wireDelivery.jid
    : facts.normalizedTarget;
  const isGroup = facts.chatType === "group";
  const route = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "whatsapp",
    accountId: params.accountId,
    recipientSessionExact: true,
    peer: facts.routePeer,
    chatType: facts.chatType,
    from: routeTarget,
    to: routeTarget,
  });
  return isGroup
    ? {
        ...route,
        sessionKey: resolveWhatsAppGroupSessionKey({
          sessionKey: route.sessionKey,
          accountId: params.accountId,
        }),
      }
    : route;
}
