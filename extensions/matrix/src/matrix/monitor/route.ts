import {
  getSessionBindingService,
  resolveAgentIdFromSessionKey,
  resolveConfiguredAcpRoute,
  type PluginRuntime,
} from "openclaw/plugin-sdk/matrix";
import type { CoreConfig } from "../../types.js";

type MatrixResolvedRoute = ReturnType<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>;

export function resolveMatrixInboundRoute(params: {
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  senderId: string;
  isDirectMessage: boolean;
  messageId: string;
  threadRootId?: string;
  eventTs?: number;
  resolveAgentRoute: PluginRuntime["channel"]["routing"]["resolveAgentRoute"];
}): {
  route: MatrixResolvedRoute;
  configuredBinding: ReturnType<typeof resolveConfiguredAcpRoute>["configuredBinding"];
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
  const bindingConversationId =
    params.threadRootId && params.threadRootId !== params.messageId
      ? params.threadRootId
      : params.roomId;
  const bindingParentConversationId =
    bindingConversationId === params.roomId ? undefined : params.roomId;
  const sessionBindingService = getSessionBindingService();
  const runtimeBinding = sessionBindingService.resolveByConversation({
    channel: "matrix",
    accountId: params.accountId,
    conversationId: bindingConversationId,
    parentConversationId: bindingParentConversationId,
  });
  const boundSessionKey = runtimeBinding?.targetSessionKey?.trim();

  if (runtimeBinding) {
    sessionBindingService.touch(runtimeBinding.bindingId, params.eventTs);
  }
  if (runtimeBinding && boundSessionKey) {
    return {
      route: {
        ...baseRoute,
        sessionKey: boundSessionKey,
        agentId: resolveAgentIdFromSessionKey(boundSessionKey) || baseRoute.agentId,
        matchedBy: "binding.channel",
      },
      configuredBinding: null,
    };
  }

  const configuredRoute =
    runtimeBinding == null
      ? resolveConfiguredAcpRoute({
          cfg: params.cfg,
          route: baseRoute,
          channel: "matrix",
          accountId: params.accountId,
          conversationId: bindingConversationId,
          parentConversationId: bindingParentConversationId,
        })
      : null;

  return {
    route: configuredRoute?.route ?? baseRoute,
    configuredBinding: configuredRoute?.configuredBinding ?? null,
  };
}
