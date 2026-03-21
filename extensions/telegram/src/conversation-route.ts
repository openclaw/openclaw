import { resolveConfiguredAcpRoute } from "../../../src/acp/persistent-bindings.route.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { logVerbose } from "../../../src/globals.js";
import { getSessionBindingService } from "../../../src/infra/outbound/session-binding-service.js";
import { isPluginOwnedSessionBindingRecord } from "../../../src/plugins/conversation-binding.js";
import {
  buildAgentSessionKey,
  deriveLastRoutePolicy,
  resolveAgentRoute,
} from "../../../src/routing/resolve-route.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_ACCOUNT_ID,
  resolveAgentIdFromSessionKey,
  sanitizeAgentId,
} from "../../../src/routing/session-key.js";
import {
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  resolveTelegramDirectPeerId,
} from "./bot/helpers.js";

export function resolveTelegramConversationRoute(params: {
  cfg: OpenClawConfig;
  accountId: string;
  chatId: number | string;
  isGroup: boolean;
  resolvedThreadId?: number;
  replyThreadId?: number;
  senderId?: string | number | null;
  topicAgentId?: string | null;
}): {
  route: ReturnType<typeof resolveAgentRoute>;
  configuredBinding: ReturnType<typeof resolveConfiguredAcpRoute>["configuredBinding"];
  configuredBindingSessionKey: string;
} {
  const peerId = params.isGroup
    ? buildTelegramGroupPeerId(params.chatId, params.resolvedThreadId)
    : resolveTelegramDirectPeerId({
        chatId: params.chatId,
        senderId: params.senderId,
      });
  const parentPeer = buildTelegramParentPeer({
    isGroup: params.isGroup,
    resolvedThreadId: params.resolvedThreadId,
    chatId: params.chatId,
  });
  let route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "telegram",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: peerId,
    },
    parentPeer,
  });

  const rawTopicAgentId = params.topicAgentId?.trim();
  if (rawTopicAgentId) {
    // Preserve the configured topic agent ID so topic-bound sessions stay stable
    // even when that agent is not present in the current config snapshot.
    const topicAgentId = sanitizeAgentId(rawTopicAgentId);
    route = {
      ...route,
      agentId: topicAgentId,
      sessionKey: buildAgentSessionKey({
        agentId: topicAgentId,
        channel: "telegram",
        accountId: params.accountId,
        peer: { kind: params.isGroup ? "group" : "direct", id: peerId },
        dmScope: params.cfg.session?.dmScope,
        identityLinks: params.cfg.session?.identityLinks,
      }).toLowerCase(),
      mainSessionKey: buildAgentMainSessionKey({
        agentId: topicAgentId,
      }).toLowerCase(),
      lastRoutePolicy: deriveLastRoutePolicy({
        sessionKey: buildAgentSessionKey({
          agentId: topicAgentId,
          channel: "telegram",
          accountId: params.accountId,
          peer: { kind: params.isGroup ? "group" : "direct", id: peerId },
          dmScope: params.cfg.session?.dmScope,
          identityLinks: params.cfg.session?.identityLinks,
        }).toLowerCase(),
        mainSessionKey: buildAgentMainSessionKey({
          agentId: topicAgentId,
        }).toLowerCase(),
      }),
    };
    logVerbose(
      `telegram: topic route override: topic=${params.resolvedThreadId ?? params.replyThreadId} agent=${topicAgentId} sessionKey=${route.sessionKey}`,
    );
  }

  const configuredRoute = resolveConfiguredAcpRoute({
    cfg: params.cfg,
    route,
    channel: "telegram",
    accountId: params.accountId,
    conversationId: peerId,
    parentConversationId: params.isGroup ? String(params.chatId) : undefined,
  });
  let configuredBinding = configuredRoute.configuredBinding;
  let configuredBindingSessionKey = configuredRoute.boundSessionKey ?? "";
  route = configuredRoute.route;

  const threadBindingConversationId =
    params.replyThreadId != null
      ? `${params.chatId}:topic:${params.replyThreadId}`
      : !params.isGroup
        ? String(params.chatId)
        : undefined;
  if (threadBindingConversationId) {
    const threadBinding = getSessionBindingService().resolveByConversation({
      channel: "telegram",
      accountId: params.accountId,
      conversationId: threadBindingConversationId,
    });
    const boundSessionKey = threadBinding?.targetSessionKey?.trim();
    if (threadBinding && boundSessionKey) {
      if (!isPluginOwnedSessionBindingRecord(threadBinding)) {
        route = {
          ...route,
          sessionKey: boundSessionKey,
          agentId: resolveAgentIdFromSessionKey(boundSessionKey),
          lastRoutePolicy: deriveLastRoutePolicy({
            sessionKey: boundSessionKey,
            mainSessionKey: route.mainSessionKey,
          }),
          matchedBy: "binding.channel",
        };
      }
      configuredBinding = null;
      configuredBindingSessionKey = "";
      getSessionBindingService().touch(threadBinding.bindingId);
      logVerbose(
        isPluginOwnedSessionBindingRecord(threadBinding)
          ? `telegram: plugin-bound conversation ${threadBindingConversationId}`
          : `telegram: routed via bound conversation ${threadBindingConversationId} -> ${boundSessionKey}`,
      );
    }
  }

  return {
    route,
    configuredBinding,
    configuredBindingSessionKey,
  };
}

export function resolveTelegramConversationBaseSessionKey(params: {
  cfg: OpenClawConfig;
  route: Pick<
    ReturnType<typeof resolveTelegramConversationRoute>["route"],
    "agentId" | "accountId" | "matchedBy" | "sessionKey"
  >;
  chatId: number | string;
  isGroup: boolean;
  senderId?: string | number | null;
}): string {
  const isNamedAccountFallback =
    params.route.accountId !== DEFAULT_ACCOUNT_ID && params.route.matchedBy === "default";
  if (!isNamedAccountFallback || params.isGroup) {
    return params.route.sessionKey;
  }
  return buildAgentSessionKey({
    agentId: params.route.agentId,
    channel: "telegram",
    accountId: params.route.accountId,
    peer: {
      kind: "direct",
      id: resolveTelegramDirectPeerId({
        chatId: params.chatId,
        senderId: params.senderId,
      }),
    },
    dmScope: "per-account-channel-peer",
    identityLinks: params.cfg.session?.identityLinks,
  }).toLowerCase();
}
