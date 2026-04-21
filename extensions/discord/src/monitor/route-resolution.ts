import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  deriveLastRoutePolicy,
  resolveAgentRoute,
  type ResolvedAgentRoute,
  type RoutePeer,
} from "openclaw/plugin-sdk/routing";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";

export function buildDiscordRoutePeer(params: {
  isDirectMessage: boolean;
  isGroupDm: boolean;
  directUserId?: string | null;
  conversationId: string;
}): RoutePeer {
  return {
    kind: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
    id: params.isDirectMessage
      ? params.directUserId?.trim() || params.conversationId
      : params.conversationId,
  };
}

export function resolveDiscordConversationRoute(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  guildId?: string | null;
  memberRoleIds?: string[];
  peer: RoutePeer;
  parentConversationId?: string | null;
  mentionedRoleAgentId?: string;
  wasBotMentioned?: boolean;
}): ResolvedAgentRoute {
  return resolveAgentRoute({
    cfg: params.cfg,
    channel: "discord",
    accountId: params.accountId,
    guildId: params.guildId ?? undefined,
    memberRoleIds: params.memberRoleIds,
    peer: params.peer,
    parentPeer: params.parentConversationId
      ? { kind: "channel", id: params.parentConversationId }
      : undefined,
    mentionedRoleAgentId: params.mentionedRoleAgentId,
    wasBotMentioned: params.wasBotMentioned,
  });
}

export function resolveDiscordBoundConversationRoute(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  guildId?: string | null;
  memberRoleIds?: string[];
  isDirectMessage: boolean;
  isGroupDm: boolean;
  directUserId?: string | null;
  conversationId: string;
  parentConversationId?: string | null;
  boundSessionKey?: string | null;
  configuredRoute?: { route: ResolvedAgentRoute } | null;
  matchedBy?: ResolvedAgentRoute["matchedBy"];
}): ResolvedAgentRoute {
  const route = resolveDiscordConversationRoute({
    cfg: params.cfg,
    accountId: params.accountId,
    guildId: params.guildId,
    memberRoleIds: params.memberRoleIds,
    peer: buildDiscordRoutePeer({
      isDirectMessage: params.isDirectMessage,
      isGroupDm: params.isGroupDm,
      directUserId: params.directUserId,
      conversationId: params.conversationId,
    }),
    parentConversationId: params.parentConversationId,
  });
  return resolveDiscordEffectiveRoute({
    route,
    boundSessionKey: params.boundSessionKey,
    configuredRoute: params.configuredRoute,
    matchedBy: params.matchedBy,
  });
}

export function resolveDiscordEffectiveRoute(params: {
  route: ResolvedAgentRoute;
  boundSessionKey?: string | null;
  configuredRoute?: { route: ResolvedAgentRoute } | null;
  matchedBy?: ResolvedAgentRoute["matchedBy"];
  mentionedRoleAgentId?: string;
}): ResolvedAgentRoute {
  const boundSessionKey = params.boundSessionKey?.trim();
  if (!boundSessionKey) {
    // Agent role @-mention overrides the configured channel binding.
    // /focus thread binding (boundSessionKey) still wins over a mention.
    if (params.mentionedRoleAgentId) {
      return params.route;
    }
    return params.configuredRoute?.route ?? params.route;
  }
  // configuredRoute is non-null only when the boundSessionKey came from a
  // configured channel binding (not an explicit /focus thread bind). In that
  // case an agent role @-mention should override the channel default.
  // When configuredRoute is null the boundSessionKey is from a real /focus
  // bind, which takes precedence over any mention.
  if (params.mentionedRoleAgentId && params.configuredRoute != null) {
    return params.route;
  }
  return {
    ...params.route,
    sessionKey: boundSessionKey,
    agentId: resolveAgentIdFromSessionKey(boundSessionKey),
    lastRoutePolicy: deriveLastRoutePolicy({
      sessionKey: boundSessionKey,
      mainSessionKey: params.route.mainSessionKey,
    }),
    ...(params.matchedBy ? { matchedBy: params.matchedBy } : {}),
  };
}
