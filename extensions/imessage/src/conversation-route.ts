import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getSessionBindingService,
  inspectRuntimeConversationBindingRoute,
  resolveConfiguredBindingRoute,
  type ConfiguredBindingRouteResult,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveIMessageInboundConversationId } from "./conversation-id.js";

export async function resolveIMessageConversationRoute(params: {
  cfg: OpenClawConfig;
  accountId: string;
  isGroup: boolean;
  peerId: string;
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
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
    chatGuid: params.chatGuid,
    chatIdentifier: params.chatIdentifier,
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
  let bindingResolution: ConfiguredBindingRouteResult["bindingResolution"] = null;
  const runtimeRoute = inspectRuntimeConversationBindingRoute({
    inspection,
    resolveRoute: ({ boundAgentId }) => {
      if (boundAgentId) {
        return resolveAgentRoute({
          ...routeInput,
          cfg: { session: params.cfg.session },
          defaultAgentId: boundAgentId,
        });
      }
      const configuredRoute = resolveConfiguredBindingRoute({
        cfg: params.cfg,
        route: resolveAgentRoute({ ...routeInput, cfg: params.cfg }),
        conversation,
      });
      bindingResolution = configuredRoute.bindingResolution;
      return configuredRoute.route;
    },
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
    bindingResolution: runtimeRoute.bindingRecord ? null : bindingResolution,
  };
}
