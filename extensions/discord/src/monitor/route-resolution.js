import {
  deriveLastRoutePolicy,
  resolveAgentRoute
} from "../../../../src/routing/resolve-route.js";
import { resolveAgentIdFromSessionKey } from "../../../../src/routing/session-key.js";
function buildDiscordRoutePeer(params) {
  return {
    kind: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
    id: params.isDirectMessage ? params.directUserId?.trim() || params.conversationId : params.conversationId
  };
}
function resolveDiscordConversationRoute(params) {
  return resolveAgentRoute({
    cfg: params.cfg,
    channel: "discord",
    accountId: params.accountId,
    guildId: params.guildId ?? void 0,
    memberRoleIds: params.memberRoleIds,
    peer: params.peer,
    parentPeer: params.parentConversationId ? { kind: "channel", id: params.parentConversationId } : void 0
  });
}
function resolveDiscordBoundConversationRoute(params) {
  const route = resolveDiscordConversationRoute({
    cfg: params.cfg,
    accountId: params.accountId,
    guildId: params.guildId,
    memberRoleIds: params.memberRoleIds,
    peer: buildDiscordRoutePeer({
      isDirectMessage: params.isDirectMessage,
      isGroupDm: params.isGroupDm,
      directUserId: params.directUserId,
      conversationId: params.conversationId
    }),
    parentConversationId: params.parentConversationId
  });
  return resolveDiscordEffectiveRoute({
    route,
    boundSessionKey: params.boundSessionKey,
    configuredRoute: params.configuredRoute,
    matchedBy: params.matchedBy
  });
}
function resolveDiscordEffectiveRoute(params) {
  const boundSessionKey = params.boundSessionKey?.trim();
  if (!boundSessionKey) {
    return params.configuredRoute?.route ?? params.route;
  }
  return {
    ...params.route,
    sessionKey: boundSessionKey,
    agentId: resolveAgentIdFromSessionKey(boundSessionKey),
    lastRoutePolicy: deriveLastRoutePolicy({
      sessionKey: boundSessionKey,
      mainSessionKey: params.route.mainSessionKey
    }),
    ...params.matchedBy ? { matchedBy: params.matchedBy } : {}
  };
}
export {
  buildDiscordRoutePeer,
  resolveDiscordBoundConversationRoute,
  resolveDiscordConversationRoute,
  resolveDiscordEffectiveRoute
};
