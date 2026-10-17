import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ConversationBindingInspection } from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { findMatrixAccountEntry, hasImplicitMatrixAccountConfig } from "../account-selection.js";
import { projectMatrixInboundRoute, resolveMatrixBindingRef } from "./monitor/route.js";

function prepareMatrixConversationRouteOwner(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversation: {
    kind: "direct" | "group" | "channel";
    peerId: string;
    threadId?: string;
    nativeChannelId?: string;
  };
}) {
  const { cfg, conversation } = params;
  const accountId = normalizeAccountId(params.accountId);
  const accountConfig = findMatrixAccountEntry(cfg, accountId);
  if (
    cfg.channels?.matrix?.enabled === false ||
    accountConfig?.enabled === false ||
    (!accountConfig && !hasImplicitMatrixAccountConfig(cfg, accountId))
  ) {
    return null;
  }
  const roomId =
    conversation.nativeChannelId?.trim() ||
    (conversation.kind === "direct" ? "" : conversation.peerId.trim());
  if (!roomId) {
    return null;
  }
  const isDirectMessage = conversation.kind === "direct";
  const route = {
    cfg,
    accountId,
    roomId,
    senderId: conversation.peerId,
    isDirectMessage,
    threadId: conversation.threadId,
    resolveAgentRoute,
  };
  return {
    conversation: resolveMatrixBindingRef(route),
    resolve(inspection: ConversationBindingInspection) {
      const result = projectMatrixInboundRoute(route, inspection);
      if (!result.bindingOwnerAvailable) {
        return { kind: "unavailable" as const };
      }
      if (result.pluginId) {
        return {
          kind: "plugin" as const,
          pluginId: result.pluginId,
          fallbackAgentId: result.route.agentId,
        };
      }
      return { kind: "agent" as const, agentId: result.route.agentId };
    },
  };
}

export async function prepareMatrixConversationRouteOwnersAsync(
  inputs: readonly Parameters<
    NonNullable<ChannelMessagingAdapter["resolveConversationRouteOwner"]>
  >[0][],
  inspectBindings: Parameters<
    NonNullable<ChannelMessagingAdapter["prepareConversationRouteOwnersAsync"]>
  >[1],
) {
  const prepared = inputs.map(prepareMatrixConversationRouteOwner);
  const inspect = await inspectBindings(
    prepared.flatMap((item) => (item ? [item.conversation] : [])),
  );
  let index = 0;
  return prepared.map((item) => {
    if (!item) {
      return () => null;
    }
    const position = index++;
    return () => item.resolve(inspect()[position]!);
  });
}
