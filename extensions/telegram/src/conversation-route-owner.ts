import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ConversationBindingInspection } from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import { resolveThreadBindingSpawnPolicy } from "openclaw/plugin-sdk/conversation-runtime";
import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { mergeTelegramAccountConfig } from "./account-config.js";
import { hasTelegramAccountConfig } from "./account-selection.js";
import { prepareTelegramConversationRouteInspection } from "./conversation-route.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import { parseTelegramTarget } from "./targets.js";
import type { TelegramThreadSpec } from "./thread-spec.js";

function prepareTelegramConversationRouteOwner(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversation: {
    kind: "direct" | "group" | "channel";
    peerId: string;
    target?: string;
    threadId?: string;
  };
}) {
  const conversation = params.conversation;
  const target = parseTelegramTarget(conversation.target?.trim() || conversation.peerId);
  const chatId = target.chatId.trim();
  if (!chatId) {
    return null;
  }
  let threadSpec: TelegramThreadSpec;
  if (target.directMessagesTopicId != null) {
    threadSpec = { id: target.directMessagesTopicId, scope: "direct-messages" };
  } else if (target.messageThreadId != null) {
    threadSpec = { id: target.messageThreadId, scope: "forum" };
  } else {
    const id = parseStrictNonNegativeInteger(conversation.threadId);
    threadSpec =
      id == null
        ? { scope: "none" }
        : { id, scope: conversation.kind === "direct" ? "dm" : "forum" };
  }
  const accountId = normalizeAccountId(params.accountId);
  const accountConfig = mergeTelegramAccountConfig(params.cfg, accountId);
  if (
    params.cfg.channels?.telegram?.enabled === false ||
    accountConfig.enabled === false ||
    !hasTelegramAccountConfig(params.cfg, accountId)
  ) {
    return null;
  }
  const { topicConfig } = resolveTelegramScopedGroupConfig(accountConfig, chatId, threadSpec.id);
  const prepared = prepareTelegramConversationRouteInspection({
    cfg: params.cfg,
    accountId,
    chatId,
    isGroup: conversation.kind !== "direct",
    threadSpec,
    senderId: conversation.kind === "direct" ? conversation.peerId : undefined,
    topicAgentId: topicConfig?.agentId,
  });
  return {
    conversation: prepared.conversation,
    resolve(inspection: ConversationBindingInspection) {
      const result = prepared.resolve(inspection);
      if (
        !result.bindingOwnerAvailable &&
        resolveThreadBindingSpawnPolicy({
          cfg: params.cfg,
          channel: "telegram",
          accountId,
          kind: "subagent",
        }).enabled
      ) {
        return { kind: "unavailable" as const };
      }
      if (result.bindingMode.kind !== "plugin-owned-runtime") {
        return { kind: "agent" as const, agentId: result.route.agentId };
      }
      return result.bindingMode.pluginId
        ? {
            kind: "plugin" as const,
            pluginId: result.bindingMode.pluginId,
            fallbackAgentId: result.route.agentId,
          }
        : null;
    },
  };
}

export async function prepareTelegramConversationRouteOwnersAsync(
  inputs: readonly Parameters<
    NonNullable<ChannelMessagingAdapter["resolveConversationRouteOwner"]>
  >[0][],
  inspectBindings: Parameters<
    NonNullable<ChannelMessagingAdapter["prepareConversationRouteOwnersAsync"]>
  >[1],
) {
  const prepared = inputs.map(prepareTelegramConversationRouteOwner);
  const inspect = await inspectBindings(
    prepared.flatMap((item) => (item ? [item.conversation] : [])),
  );
  let index = 0;
  return prepared.map((item) => {
    if (!item) return () => null;
    const position = index++;
    return () => item.resolve(inspect()[position]!);
  });
}
