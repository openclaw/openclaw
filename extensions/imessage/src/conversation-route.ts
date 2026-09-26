import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getSessionBindingService,
  inspectRuntimeConversationBindingRoute,
  resolveConfiguredBindingRoute,
  type ConfiguredBindingRouteResult,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import { parseAgentSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveIMessageInboundConversationId } from "./conversation-id.js";

export async function resolveIMessageConversationRoute(params: {
  cfg: OpenClawConfig;
  accountId: string;
  isGroup: boolean;
  peerId: string;
  sender: string;
  chatId?: number;
}): Promise<ConfiguredBindingRouteResult> {
  const routeInput = {
    channel: "imessage",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? ("group" as const) : ("direct" as const),
      id: params.peerId,
    },
  };

  const conversationId = resolveIMessageInboundConversationId({
    isGroup: params.isGroup,
    sender: params.sender,
    chatId: params.chatId,
  });
  if (!conversationId) {
    return {
      route: resolveAgentRoute({ ...routeInput, cfg: params.cfg }),
      bindingResolution: null,
    };
  }

  const conversation = {
    channel: "imessage",
    accountId: params.accountId,
    conversationId,
  };
  const service = getSessionBindingService();
  const inspection = await service.inspectByConversationAsync(conversation);
  if (inspection.status === "unavailable") {
    throw new Error(
      "iMessage conversation binding owner is temporarily unavailable; retry the message.",
    );
  }
  // Classify through the binding owner without consulting the ordinary roster or bindings.
  // This scope-only route is never dispatched; the selected owner supplies the final agent.
  const resolveScopeRoute = (agentId?: string) =>
    resolveAgentRoute({
      ...routeInput,
      cfg: { session: params.cfg.session },
      defaultAgentId: agentId,
    });
  const selection = inspectRuntimeConversationBindingRoute({
    route: resolveScopeRoute(),
    inspection,
  });
  const metadataAgentId = selection.bindingRecord?.metadata?.agentId;
  const hasBoundAgent =
    selection.boundSessionKey &&
    (parseAgentSessionKey(selection.boundSessionKey) ||
      (typeof metadataAgentId === "string" && metadataAgentId.trim()));
  const configuredRoute: ConfiguredBindingRouteResult = hasBoundAgent
    ? { route: resolveScopeRoute(selection.boundAgentId), bindingResolution: null }
    : resolveConfiguredBindingRoute({
        cfg: params.cfg,
        route: resolveAgentRoute({ ...routeInput, cfg: params.cfg }),
        conversation,
      });
  const runtimeRoute = inspectRuntimeConversationBindingRoute({
    route: configuredRoute.route,
    inspection,
  });
  if (runtimeRoute.bindingRecord) {
    // Keep the captured selection through this await. The reply owner must reject a
    // revoked/reassigned binding, rather than silently dispatching under another owner.
    await service.touchAsync(
      runtimeRoute.bindingRecord.bindingId,
      undefined,
      runtimeRoute.bindingRecord.conversation,
    );
  }
  if (runtimeRoute.bindingRecord && !runtimeRoute.boundSessionKey) {
    logVerbose(`imessage: plugin-bound conversation ${conversationId}`);
  } else if (runtimeRoute.boundSessionKey) {
    logVerbose(
      `imessage: routed via bound conversation ${conversationId} -> ${runtimeRoute.boundSessionKey}`,
    );
  }
  return {
    route: runtimeRoute.route,
    bindingResolution: runtimeRoute.bindingRecord ? null : configuredRoute.bindingResolution,
  };
}
