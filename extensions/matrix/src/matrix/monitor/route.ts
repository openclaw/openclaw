import {
  getSessionBindingService,
  resolveAgentIdFromSessionKey,
  resolveConfiguredAcpBindingRecord,
  type PluginRuntime,
} from "../../runtime-api.js";
import type { CoreConfig } from "../../types.js";
import { resolveMatrixThreadSessionKeys } from "./threads.js";

type MatrixResolvedRoute = ReturnType<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>;

export function resolveMatrixInboundRoute(params: {
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  senderId: string;
  isDirectMessage: boolean;
  threadId?: string;
  eventTs?: number;
  resolveAgentRoute: PluginRuntime["channel"]["routing"]["resolveAgentRoute"];
}): {
  route: MatrixResolvedRoute;
  configuredBinding: ReturnType<typeof resolveConfiguredAcpBindingRecord>;
  runtimeBindingId: string | null;
} {
  const baseRoute = params.resolveAgentRoute({
    cfg: params.cfg,
    channel: "matrix",
    accountId: params.accountId,
    peer: {
      kind: params.isDirectMessage ? "direct" : "channel",
      id: params.isDirectMessage ? params.senderId : params.roomId,
    },
    // Matrix DMs are still sender-addressed first, but the room ID remains a
    // useful fallback binding key for generic route matching.
    parentPeer: params.isDirectMessage
      ? {
          kind: "channel",
          id: params.roomId,
        }
      : undefined,
  });
  const bindingConversationId = params.threadId ?? params.roomId;
  const bindingParentConversationId = params.threadId ? params.roomId : undefined;
  const sessionBindingService = getSessionBindingService();
  const runtimeBinding = sessionBindingService.resolveByConversation({
    channel: "matrix",
    accountId: params.accountId,
    conversationId: bindingConversationId,
    parentConversationId: bindingParentConversationId,
  });
  const boundSessionKey = runtimeBinding?.targetSessionKey?.trim();

  if (runtimeBinding && boundSessionKey) {
    return {
      route: {
        ...baseRoute,
        sessionKey: boundSessionKey,
        agentId: resolveAgentIdFromSessionKey(boundSessionKey) || baseRoute.agentId,
        matchedBy: "binding.channel",
      },
      configuredBinding: null,
      runtimeBindingId: runtimeBinding.bindingId,
    };
  }

  const configuredBinding =
    runtimeBinding == null
      ? resolveConfiguredAcpBindingRecord({
          cfg: params.cfg,
          channel: "matrix",
          accountId: params.accountId,
          conversationId: bindingConversationId,
          parentConversationId: bindingParentConversationId,
        })
      : null;
  const configuredSessionKey = configuredBinding?.record.targetSessionKey?.trim();

  const effectiveRoute =
    configuredBinding && configuredSessionKey
      ? {
          ...baseRoute,
          sessionKey: configuredSessionKey,
          agentId:
            resolveAgentIdFromSessionKey(configuredSessionKey) ||
            configuredBinding.spec.agentId ||
            baseRoute.agentId,
          matchedBy: "binding.channel" as const,
        }
      : baseRoute;

  // When no binding overrides the session key, isolate threads into their own sessions.
  if (!configuredBinding && !configuredSessionKey && params.threadId) {
    const threadKeys = resolveMatrixThreadSessionKeys({
      baseSessionKey: effectiveRoute.sessionKey,
      threadId: params.threadId,
      parentSessionKey: effectiveRoute.sessionKey,
    });
    return {
      route: {
        ...effectiveRoute,
        sessionKey: threadKeys.sessionKey,
        mainSessionKey: threadKeys.parentSessionKey ?? effectiveRoute.sessionKey,
      },
      configuredBinding,
      runtimeBindingId: null,
    };
  }

  return {
    route: effectiveRoute,
    configuredBinding,
    runtimeBindingId: null,
  };
}
