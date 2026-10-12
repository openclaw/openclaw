import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveThreadBindingSpawnPolicy } from "openclaw/plugin-sdk/conversation-runtime";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { mergeTelegramAccountConfig } from "./account-config.js";
import { hasTelegramAccountConfig } from "./account-selection.js";
import { inspectTelegramConversationRoute } from "./conversation-route.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import { parseTelegramTarget } from "./targets.js";
import type { TelegramThreadSpec } from "./thread-spec.js";

export function inspectTelegramConversationRouteOwner(params: {
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
  const result = inspectTelegramConversationRoute({
    cfg: params.cfg,
    accountId,
    chatId,
    isGroup: conversation.kind !== "direct",
    threadSpec,
    senderId: conversation.kind === "direct" ? conversation.peerId : undefined,
    topicAgentId: topicConfig?.agentId,
  });
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
}
