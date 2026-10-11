import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SessionBindingRecord } from "openclaw/plugin-sdk/conversation-runtime";
import {
  deriveLastRoutePolicy,
  isAcpSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
  resolveAgentRoute,
  type ResolvedAgentRoute,
  type RoutePeer,
  resolveAgentIdFromSessionKey,
} from "openclaw/plugin-sdk/routing";

/**
 * Local free-harness check (mirrors core `isFreeAcpSessionKey`). Kept plugin-local so this
 * hot monitor path adds no new public SDK export.
 */
function isFreeAcpHarnessKey(sessionKey: string | undefined | null): boolean {
  const rest = parseAgentSessionKey(sessionKey ?? undefined)?.rest?.toLowerCase();
  return rest?.startsWith("acp:") === true && !rest.startsWith("acp:binding:");
}

export function buildDiscordRoutePeer(params: {
  isDirectMessage: boolean;
  isGroupDm: boolean;
  directUserId?: string | null;
  conversationId: string;
}): RoutePeer {
  return {
    kind: params.isGroupDm ? "group" : params.isDirectMessage ? "direct" : "channel",
    id:
      params.isDirectMessage && !params.isGroupDm
        ? params.directUserId?.trim() || params.conversationId
        : params.conversationId,
  };
}

export function buildDiscordConversationRouteContext(params: {
  isDirectMessage: boolean;
  isGroupDm: boolean;
  directUserId?: string | null;
  conversationId: string;
  isThread: boolean;
  parentConversationId?: string;
}) {
  return {
    ConversationRouteContextObserved: true as const,
    ConversationRoutePeerId: buildDiscordRoutePeer(params).id,
    NativeChannelId: params.conversationId,
    InboundAccessAuthorized: true as const,
    MessageThreadId: params.isThread ? params.conversationId : undefined,
    ThreadParentId: params.isThread ? params.parentConversationId : undefined,
  };
}

export function resolveDiscordConversationRoute(params: {
  cfg: OpenClawConfig;
  defaultAgentId?: string;
  accountId?: string | null;
  guildId?: string | null;
  memberRoleIds?: string[];
  peer: RoutePeer;
  parentConversationId?: string | null;
}): ResolvedAgentRoute {
  const input = {
    cfg: params.cfg,
    channel: "discord",
    accountId: params.accountId,
    guildId: params.guildId ?? undefined,
    memberRoleIds: params.memberRoleIds,
    peer: params.peer,
    parentPeer: params.parentConversationId
      ? { kind: "channel" as const, id: params.parentConversationId }
      : undefined,
  };
  try {
    return resolveAgentRoute(input);
  } catch (error) {
    if (
      !params.defaultAgentId ||
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "AGENT_SELECTION_REQUIRED"
    ) {
      throw error;
    }
    // Preserve ordinary routes for stale-binding comparison when selection succeeds.
    return resolveAgentRoute({ ...input, defaultAgentId: params.defaultAgentId });
  }
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
    ...params,
    peer: buildDiscordRoutePeer(params),
  });
  return resolveDiscordEffectiveRoute({ ...params, route });
}

export function resolveDiscordEffectiveRoute(params: {
  route: ResolvedAgentRoute;
  boundSessionKey?: string | null;
  configuredRoute?: { route: ResolvedAgentRoute } | null;
  matchedBy?: ResolvedAgentRoute["matchedBy"];
}): ResolvedAgentRoute {
  const boundSessionKey = params.boundSessionKey?.trim();
  if (!boundSessionKey) {
    return params.configuredRoute?.route ?? params.route;
  }
  return {
    ...params.route,
    sessionKey: boundSessionKey,
    agentId: resolveAgentIdFromSessionKey(boundSessionKey),
    // A free ACP key names an external harness; the routed channel agent keeps dispatch ownership.
    ...(isFreeAcpHarnessKey(boundSessionKey) ? { ownerAgentId: params.route.agentId } : {}),
    lastRoutePolicy: deriveLastRoutePolicy({
      sessionKey: boundSessionKey,
      mainSessionKey: params.route.mainSessionKey,
    }),
    ...(params.matchedBy ? { matchedBy: params.matchedBy } : {}),
  };
}

function hasExplicitRuntimeBindingIntent(record: SessionBindingRecord): boolean {
  if (record.targetKind === "subagent") {
    return true;
  }
  if (isAcpSessionKey(record.targetSessionKey) || isSubagentSessionKey(record.targetSessionKey)) {
    return true;
  }
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  return (
    typeof metadata.boundBy === "string" ||
    typeof metadata.label === "string" ||
    typeof metadata.threadName === "string" ||
    metadata.pluginBindingOwner === "plugin"
  );
}

export function shouldIgnoreStaleDiscordRouteBinding(params: {
  bindingRecord?: SessionBindingRecord | null;
  route: ResolvedAgentRoute;
}): boolean {
  const bindingRecord = params.bindingRecord;
  const boundSessionKey = bindingRecord?.targetSessionKey?.trim();
  if (!bindingRecord || !boundSessionKey || hasExplicitRuntimeBindingIntent(bindingRecord)) {
    return false;
  }
  const bound = parseAgentSessionKey(boundSessionKey);
  const routed = parseAgentSessionKey(params.route.sessionKey);
  if (!bound || !routed || bound.rest !== routed.rest) {
    return false;
  }
  return bound.agentId !== params.route.agentId;
}
