import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ConversationBindingInspection } from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import { resolveThreadBindingSpawnPolicy } from "openclaw/plugin-sdk/conversation-runtime";
import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";
import { listDiscordAccountIds, resolveDiscordAccountConfig } from "./accounts.js";
import { resolveDiscordRuntimeBindingConversationId } from "./conversation-identity.js";
import { resolveDiscordConversationBindingRoute } from "./monitor/conversation-binding-route.js";
import { resolveDiscordConversationRoute } from "./monitor/route-resolution.js";

function prepareDiscordConversationRouteOwner(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversation: {
    kind: "direct" | "group" | "channel";
    peerId: string;
    threadId?: string;
    nativeChannelId?: string;
    context?: {
      parentPeerId?: string;
      guildId?: string;
      memberRoleIds?: string[];
    };
  };
}) {
  const accountId = normalizeAccountId(params.accountId);
  if (
    params.cfg.channels?.discord?.enabled === false ||
    !listDiscordAccountIds(params.cfg).some((id) => normalizeAccountId(id) === accountId) ||
    resolveDiscordAccountConfig(params.cfg, accountId)?.enabled === false
  ) {
    return null;
  }
  const direct = params.conversation.kind === "direct";
  const nativeConversationId = params.conversation.nativeChannelId ?? params.conversation.peerId;
  const threadConversationId = direct ? undefined : params.conversation.threadId;
  const runtimeConversationId =
    threadConversationId ??
    resolveDiscordRuntimeBindingConversationId({
      isDirectMessage: direct,
      isGroupDm: params.conversation.kind === "group",
      userId: direct ? params.conversation.peerId : undefined,
      channelId: nativeConversationId,
    });
  const route = ({ boundAgentId }: { boundAgentId?: string }) =>
    resolveDiscordConversationRoute({
      cfg: params.cfg,
      defaultAgentId: boundAgentId,
      accountId,
      guildId: params.conversation.context?.guildId,
      memberRoleIds: params.conversation.context?.memberRoleIds,
      peer: { kind: params.conversation.kind, id: params.conversation.peerId },
      parentConversationId: params.conversation.context?.parentPeerId,
    });
  const input = {
    cfg: params.cfg,
    resolveRoute: route,
    accountId,
    runtimeConversationId,
    configuredConversationId: threadConversationId ?? nativeConversationId,
    parentConversationId: params.conversation.context?.parentPeerId,
    touchBinding: false,
  };
  return {
    conversation: {
      channel: "discord",
      accountId,
      conversationId: runtimeConversationId,
      parentConversationId: params.conversation.context?.parentPeerId,
    },
    resolve(inspection: ConversationBindingInspection) {
      const { runtimeRoute, configuredRoute } = resolveDiscordConversationBindingRoute({
        ...input,
        inspection,
      });
      if (
        !runtimeRoute.bindingOwnerAvailable &&
        resolveThreadBindingSpawnPolicy({
          cfg: params.cfg,
          channel: "discord",
          accountId,
          kind: "subagent",
        }).enabled
      ) {
        return { kind: "unavailable" as const };
      }
      if (runtimeRoute.pluginId) {
        return {
          kind: "plugin" as const,
          pluginId: runtimeRoute.pluginId,
          fallbackAgentId: runtimeRoute.route.agentId,
        };
      }
      return {
        kind: "agent" as const,
        agentId:
          runtimeRoute.boundAgentId ?? configuredRoute?.boundAgentId ?? runtimeRoute.route.agentId,
      };
    },
  };
}

export async function prepareDiscordConversationRouteOwnersAsync(
  inputs: readonly Parameters<
    NonNullable<ChannelMessagingAdapter["resolveConversationRouteOwner"]>
  >[0][],
  inspectBindings: Parameters<
    NonNullable<ChannelMessagingAdapter["prepareConversationRouteOwnersAsync"]>
  >[1],
) {
  const prepared = inputs.map(prepareDiscordConversationRouteOwner);
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
