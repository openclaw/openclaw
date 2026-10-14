import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import {
  buildChannelGroupsScopeTree,
  resolveChannelGroupRequireMention,
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  type GroupToolPolicyConfig,
  type ScopeTree,
} from "openclaw/plugin-sdk/channel-policy";

function parseTelegramGroupId(value?: string | null) {
  const raw = value?.trim() ?? "";
  if (!raw) {
    return { chatId: undefined, topicId: undefined };
  }
  const [chatId, second, third] = raw.split(":").filter(Boolean);
  const topicId = second === "topic" ? third : second;
  if (
    chatId !== undefined &&
    /^-?\d+$/.test(chatId) &&
    topicId !== undefined &&
    /^\d+$/.test(topicId)
  ) {
    return { chatId, topicId };
  }
  return { chatId: raw, topicId: undefined };
}

export function resolveTelegramGroupRequireMention(
  params: ChannelGroupContext,
): boolean | undefined {
  const { chatId, topicId } = parseTelegramGroupId(params.groupId);
  if (chatId) {
    const groups =
      (params.accountId
        ? params.cfg.channels?.telegram?.accounts?.[params.accountId]?.groups
        : undefined) ?? params.cfg.channels?.telegram?.groups;
    const groupConfig = groups?.[chatId];
    const groupDefault = groups?.["*"];
    const entries = [groupDefault, groupConfig];
    if (topicId) {
      // Broad to narrow; wildcard-group topics outrank exact-group scalar policy.
      entries.push(
        groupDefault?.topics?.["*"],
        groupDefault?.topics?.[topicId],
        groupConfig?.topics?.["*"],
        groupConfig?.topics?.[topicId],
      );
    }
    const scopes: ScopeTree["scopes"] = {};
    for (const [index, entry] of entries.entries()) {
      if (entry) {
        scopes[index] = { requireMention: entry.requireMention };
      }
    }
    const path = Object.keys(scopes);
    if (path.some((key) => typeof scopes[key]?.requireMention === "boolean")) {
      return resolveScopeRequireMention({ tree: { scopes }, path });
    }
  }
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "telegram",
    groupId: chatId ?? params.groupId,
    accountId: params.accountId,
  });
}

export function resolveTelegramGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const { chatId } = parseTelegramGroupId(params.groupId);
  const groupId = chatId ?? params.groupId?.trim();
  return resolveScopeToolsPolicy({
    tree: buildChannelGroupsScopeTree(params.cfg, "telegram", params.accountId),
    path: groupId ? [groupId] : [],
    senderPolicyMode: params.senderPolicyMode,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    messageProvider: "telegram",
  });
}
