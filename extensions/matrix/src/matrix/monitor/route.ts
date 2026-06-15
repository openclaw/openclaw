// Matrix plugin module implements route behavior.
import { resolveConfiguredAcpBindingRecord } from "openclaw/plugin-sdk/acp-binding-resolve-runtime";
import { resolveRuntimeConversationBindingRoute } from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  buildAgentSessionKey,
  deriveLastRoutePolicy,
  resolveAgentIdFromSessionKey,
} from "openclaw/plugin-sdk/routing";
import type { CoreConfig } from "../../types.js";
import { resolveMatrixThreadSessionKeys } from "./threads.js";

type MatrixResolvedRoute = ReturnType<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>;

function resolveMatrixDmSessionKey(params: {
  accountId: string;
  agentId: string;
  roomId: string;
  dmSessionScope?: "per-user" | "per-room";
  fallbackSessionKey: string;
}): string {
  if (params.dmSessionScope !== "per-room") {
    return params.fallbackSessionKey;
  }
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: "matrix",
    accountId: params.accountId,
    peer: {
      kind: "channel",
      id: params.roomId,
    },
  });
}

function shouldApplyMatrixPerRoomDmSessionScope(params: {
  isDirectMessage: boolean;
  configuredSessionKey?: string;
}): boolean {
  return params.isDirectMessage && !params.configuredSessionKey;
}

export function resolveMatrixInboundRoute(params: {
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  senderId: string;
  isDirectMessage: boolean;
  dmSessionScope?: "per-user" | "per-room";
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
  const conversation = {
    channel: "matrix" as const,
    accountId: params.accountId,
    conversationId: bindingConversationId,
    parentConversationId: bindingParentConversationId,
  };

  // Resolve configured ACP binding through the compiled binding registry.
  // This follows the same binding resolution chain used by Discord and Telegram:
  // both use the compiled-configured-binding registry to match per-conversation ACP bindings.
  const configuredBinding = resolveConfiguredAcpBindingRecord({
    cfg: params.cfg,
    channel: conversation.channel,
    accountId: conversation.accountId,
    conversationId: conversation.conversationId,
    parentConversationId: conversation.parentConversationId,
  });
  const configuredSessionKey = configuredBinding?.record.targetSessionKey?.trim();

  let route: MatrixResolvedRoute =
    configuredBinding && configuredSessionKey
      ? {
          ...baseRoute,
          sessionKey: configuredSessionKey,
          agentId:
            resolveAgentIdFromSessionKey(configuredSessionKey) ||
            configuredBinding.spec.agentId ||
            baseRoute.agentId,
          lastRoutePolicy: deriveLastRoutePolicy({
            sessionKey: configuredSessionKey,
            mainSessionKey: baseRoute.mainSessionKey,
          }),
          matchedBy: "binding.channel" as const,
        }
      : baseRoute;

  // Check for runtime session bindings (e.g. from thread bind commands or plugin-owned bindings).
  // This uses the shared resolveRuntimeConversationBindingRoute from the conversation-binding-runtime
  // module, matching the pattern used by Discord and Telegram.
  const runtimeRoute = resolveRuntimeConversationBindingRoute({
    route,
    conversation,
  });
  route = runtimeRoute.route;
  const runtimeBindingId = runtimeRoute.bindingRecord?.bindingId ?? null;

  const dmSessionKey = shouldApplyMatrixPerRoomDmSessionScope({
    isDirectMessage: params.isDirectMessage,
    configuredSessionKey,
  })
    ? resolveMatrixDmSessionKey({
        accountId: params.accountId,
        agentId: route.agentId,
        roomId: params.roomId,
        dmSessionScope: params.dmSessionScope,
        fallbackSessionKey: route.sessionKey,
      })
    : route.sessionKey;
  const routeWithDmScope =
    dmSessionKey === route.sessionKey
      ? route
      : {
          ...route,
          sessionKey: dmSessionKey,
          lastRoutePolicy: "session" as const,
        };

  // When no binding overrides the session key, isolate threads into their own sessions.
  if (!configuredBinding && !configuredSessionKey && params.threadId) {
    const threadKeys = resolveMatrixThreadSessionKeys({
      baseSessionKey: routeWithDmScope.sessionKey,
      threadId: params.threadId,
      parentSessionKey: routeWithDmScope.sessionKey,
    });
    return {
      route: {
        ...routeWithDmScope,
        sessionKey: threadKeys.sessionKey,
        mainSessionKey: threadKeys.parentSessionKey ?? routeWithDmScope.sessionKey,
        lastRoutePolicy: deriveLastRoutePolicy({
          sessionKey: threadKeys.sessionKey,
          mainSessionKey: threadKeys.parentSessionKey ?? routeWithDmScope.sessionKey,
        }),
      },
      configuredBinding,
      runtimeBindingId,
    };
  }

  return {
    route: routeWithDmScope,
    configuredBinding,
    runtimeBindingId,
  };
}
