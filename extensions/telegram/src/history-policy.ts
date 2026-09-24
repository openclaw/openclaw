import type { Message } from "grammy/types";
import { resolveChannelGroupPolicy } from "openclaw/plugin-sdk/channel-policy";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { expandTelegramAllowFromWithAccessGroups } from "./access-groups.js";
import { mergeTelegramAccountConfig } from "./account-config.js";
import { firstDefined, normalizeAllowFrom } from "./bot-access.js";
import { getTelegramTextParts } from "./bot/helpers.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";
import {
  isTelegramMessageFromCurrentBot,
  type TelegramCachedMessageNode,
} from "./message-cache-codec.js";
import type { TelegramMessageCache } from "./message-cache.js";

type TelegramHistoryScope = {
  cfg: OpenClawConfig;
  accountId: string;
  chatId: string | number;
  threadId?: number;
  botUserId?: number;
  assertCurrent?: () => void;
};

function createTelegramHistoryPolicyAssertion(
  params: TelegramHistoryScope,
  cfg: OpenClawConfig,
  getConfig: () => OpenClawConfig,
) {
  return () => {
    params.assertCurrent?.();
    if (getConfig() !== cfg) {
      throw new Error(
        "Telegram history policy changed during the read; retry with current permissions.",
      );
    }
  };
}

export async function isTelegramHistoryNodeAllowed(
  params: TelegramHistoryScope & { node: TelegramCachedMessageNode },
): Promise<boolean> {
  params.assertCurrent?.();
  const { node } = params;
  const msg = node.sourceMessage;
  if (
    node.historyEligible !== true ||
    (msg.chat.type !== "group" && msg.chat.type !== "supergroup") ||
    node.threadBinding?.threadSpec.scope === "dm" ||
    node.threadBinding?.threadSpec.scope === "direct-messages" ||
    String(msg.chat.id) !== String(params.chatId) ||
    node.threadId !== (params.threadId === undefined ? undefined : String(params.threadId))
  ) {
    return false;
  }
  return await isTelegramHistorySenderAllowed({
    ...params,
    senderId: msg.from?.id == null ? "" : String(msg.from.id),
    message: msg,
  });
}

export async function isTelegramHistorySenderAllowed(
  params: TelegramHistoryScope & { senderId: string; message?: Message },
): Promise<boolean> {
  params.assertCurrent?.();
  const getConfig = createRuntimeConfigReader(params.cfg);
  const cfg = getConfig();
  const assertCurrent = createTelegramHistoryPolicyAssertion(params, cfg, getConfig);
  const telegramCfg = mergeTelegramAccountConfig(cfg, params.accountId);
  if (
    !cfg.channels?.telegram ||
    cfg.channels.telegram.enabled === false ||
    telegramCfg.enabled === false
  ) {
    return false;
  }
  const { groupConfig, topicConfig } = resolveTelegramScopedGroupConfig(
    telegramCfg,
    params.chatId,
    params.threadId,
  );
  const ownBot =
    params.message !== undefined &&
    params.botUserId !== undefined &&
    isTelegramMessageFromCurrentBot(params.message, params.botUserId);
  const senderId = params.senderId;
  const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  const effectiveGroupAllow = normalizeAllowFrom(
    await expandTelegramAllowFromWithAccessGroups({
      cfg,
      accountId: params.accountId,
      senderId,
      allowFrom: groupAllowOverride ?? telegramCfg.groupAllowFrom ?? telegramCfg.allowFrom,
    }),
  );
  assertCurrent();
  if (
    !evaluateTelegramGroupBaseAccess({
      isGroup: true,
      groupConfig,
      topicConfig,
      hasGroupAllowOverride: groupAllowOverride !== undefined,
      effectiveGroupAllow,
      senderId,
      enforceAllowOverride: !ownBot,
      requireSenderForAllowOverride: true,
    }).allowed
  ) {
    return false;
  }
  const text = params.message && getTelegramTextParts(params.message);
  const isCommand =
    !ownBot &&
    text !== undefined &&
    (hasControlCommand(text.text, cfg) ||
      text.entities.some((entity) => entity.type === "bot_command" && entity.offset === 0));
  const commandAccess = isCommand
    ? await resolveTelegramCommandIngressAuthorization({
        accountId: params.accountId,
        cfg,
        dmPolicy: "pairing",
        isGroup: true,
        chatId: params.chatId,
        resolvedThreadId: params.threadId,
        senderId: senderId ?? "",
        effectiveGroupAllow,
        eventKind: "message",
        allowTextCommands: true,
        hasControlCommand: true,
        modeWhenAccessGroupsOff: "allow",
        includeDmAllowForGroupCommands: false,
      })
    : undefined;
  assertCurrent();
  if (commandAccess && !commandAccess.authorized) {
    return false;
  }
  return evaluateTelegramGroupPolicyAccess({
    isGroup: true,
    chatId: params.chatId,
    cfg,
    telegramCfg,
    groupConfig,
    topicConfig,
    effectiveGroupAllow,
    senderId,
    resolveGroupPolicy: (chatId, currentCfg) =>
      resolveChannelGroupPolicy({
        cfg: currentCfg,
        channel: "telegram",
        accountId: params.accountId,
        groupId: String(chatId),
      }),
    enforcePolicy: true,
    enforceAllowlistAuthorization: !ownBot && !commandAccess?.authorizedByConfig,
    allowEmptyAllowlistEntries: false,
    requireSenderForAllowlistAuthorization: true,
    checkChatAllowlist: true,
  }).allowed;
}

export async function readTelegramHistoryWindow(
  params: TelegramHistoryScope & {
    cache: TelegramMessageCache;
    before?: string;
    limit: number;
  },
): Promise<TelegramCachedMessageNode[]> {
  if (!Number.isSafeInteger(params.limit) || params.limit <= 0) {
    return [];
  }
  const getConfig = createRuntimeConfigReader(params.cfg);
  const cfg = getConfig();
  const assertCurrent = createTelegramHistoryPolicyAssertion(params, cfg, getConfig);
  assertCurrent();
  // Automatic turns inspect a physical window; only explicit reads page deeper for matches.
  const candidates = await params.cache.readHistoryWindow({
    accountId: params.accountId,
    chatId: params.chatId,
    threadId: params.threadId,
    before: params.before,
    limit: Math.max(256, params.limit),
  });
  assertCurrent();
  const messages: TelegramCachedMessageNode[] = [];
  for (let index = candidates.length - 1; index >= 0 && messages.length < params.limit; index--) {
    const node = candidates[index]!;
    const allowed = await isTelegramHistoryNodeAllowed({ ...params, cfg, node, assertCurrent });
    assertCurrent();
    if (allowed) {
      messages.push(node);
    }
  }
  messages.reverse();
  return messages;
}

export async function readTelegramHistory(
  params: TelegramHistoryScope & {
    cache: TelegramMessageCache;
    before?: string;
    after?: string;
    limit: number;
  },
): Promise<{ messages: TelegramCachedMessageNode[]; hasMore: boolean }> {
  if (params.limit <= 0) {
    return { messages: [], hasMore: false };
  }
  const getConfig = createRuntimeConfigReader(params.cfg);
  const cfg = getConfig();
  const assertCurrent = createTelegramHistoryPolicyAssertion(params, cfg, getConfig);
  const ascending = params.after !== undefined && params.before === undefined;
  let before = params.before;
  let after = params.after;
  const messages: TelegramCachedMessageNode[] = [];
  while (messages.length <= params.limit) {
    assertCurrent();
    const page = await params.cache.readHistory({
      accountId: params.accountId,
      chatId: params.chatId,
      threadId: params.threadId,
      before,
      after,
      limit: Math.min(100, params.limit + 1),
    });
    assertCurrent();
    const candidates = ascending ? page.messages : page.messages.toReversed();
    for (const node of candidates) {
      const allowed = await isTelegramHistoryNodeAllowed({ ...params, cfg, node, assertCurrent });
      assertCurrent();
      if (allowed) {
        messages.push(node);
        if (messages.length > params.limit) {
          break;
        }
      }
    }
    if (!page.hasMore || page.messages.length === 0) {
      break;
    }
    if (ascending) {
      after = page.messages.at(-1)!.messageId;
    } else {
      before = page.messages[0]!.messageId;
    }
  }
  const hasMore = messages.length > params.limit;
  if (hasMore) {
    messages.pop();
  }
  if (!ascending) {
    messages.reverse();
  }
  assertCurrent();
  return { messages, hasMore };
}
