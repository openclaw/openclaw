import { resolveChannelGroupPolicy } from "openclaw/plugin-sdk/channel-policy";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  expandTelegramAllowFromWithAccessGroups,
  resolveTelegramDmAllow,
} from "./access-groups.js";
import {
  firstDefined,
  normalizeAllowFrom,
  resolveTelegramEffectiveDmPolicy,
} from "./bot-access.js";
import { hasLeadingBotCommandAddressedToOtherBot } from "./bot/body-helpers.js";
import {
  resolveTelegramGroupAllowFromContext,
  resolveTelegramMessageThreadSpec,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import { isTelegramDmAccessAllowed } from "./dm-access.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";
import {
  isTelegramMessageFromCurrentBot,
  resolveProviderObservedTelegramThreadSpec,
  type TelegramCachedMessageNode,
} from "./message-cache.js";

/** Cache observations (including embedded replies) are data, not ingress authority. */
export async function selectAllowedTelegramCachedContext(params: {
  cfg: OpenClawConfig;
  telegramCfg: TelegramAccountConfig;
  accountId: string;
  chatId: string | number;
  threadSpec: TelegramThreadSpec;
  botId?: number;
  botUsername?: string;
  nodes: readonly TelegramCachedMessageNode[];
  groupAllowFrom?: Array<string | number>;
}): Promise<Set<string>> {
  const { groupConfig, topicConfig } = resolveTelegramScopedGroupConfig(
    params.telegramCfg,
    params.chatId,
    params.threadSpec.id,
  );
  const override = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  const allowFrom =
    override ??
    params.groupAllowFrom ??
    params.telegramCfg.groupAllowFrom ??
    params.telegramCfg.allowFrom;
  const allowed = new Set<string>();
  const senderAccess = new Map<string, ReturnType<typeof normalizeAllowFrom>>();
  const dmAccess = new Map<string, boolean>();
  for (const node of params.nodes) {
    const msg = node.sourceMessage;
    if (node.historyEligible !== true || String(msg.chat?.id) !== String(params.chatId)) {
      continue;
    }
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    if (!isGroup && msg.chat.type !== "private") {
      continue;
    }
    const observedThread = resolveProviderObservedTelegramThreadSpec(node);
    if (
      params.threadSpec.id === undefined
        ? observedThread !== undefined || resolveTelegramMessageThreadSpec(msg).id !== undefined
        : observedThread?.id !== params.threadSpec.id ||
          observedThread.scope !== params.threadSpec.scope
    ) {
      continue;
    }
    const isSelf =
      Boolean(params.botId && isTelegramMessageFromCurrentBot(node.sourceMessage, params.botId)) ||
      (node.sourceMessage.from?.id === 0 && node.sourceMessage.from.is_bot);
    if (!isGroup) {
      const senderId = isSelf ? String(params.chatId) : (node.senderId ?? "");
      if (!dmAccess.has(senderId)) {
        const context = await resolveTelegramGroupAllowFromContext({
          cfg: params.cfg,
          accountId: params.accountId,
          chatId: params.chatId,
          threadSpec: params.threadSpec,
          senderId,
          isGroup: false,
          dmPolicy: params.telegramCfg.dmPolicy,
          allowFrom: params.telegramCfg.allowFrom,
          resolveTelegramGroupConfig: () => ({ groupConfig, topicConfig }),
        });
        const dmPolicy = resolveTelegramEffectiveDmPolicy({
          isGroup: false,
          groupConfig,
          dmPolicy: params.telegramCfg.dmPolicy,
        });
        const dmAllow = await resolveTelegramDmAllow({
          cfg: params.cfg,
          accountId: params.accountId,
          senderId,
          dmPolicy,
          allowFrom: params.telegramCfg.allowFrom,
          groupAllowOverride: context.groupAllowOverride,
          storeAllowFrom: context.storeAllowFrom,
        });
        dmAccess.set(
          senderId,
          evaluateTelegramGroupBaseAccess({
            ...context,
            isGroup: false,
            senderId,
            enforceAllowOverride: true,
            requireSenderForAllowOverride: true,
          }).allowed &&
            (await isTelegramDmAccessAllowed({
              accountId: params.accountId,
              dmPolicy,
              senderId,
              effectiveDmAllow: dmAllow.effectiveAllow,
            })),
        );
      }
      if (dmAccess.get(senderId)) {
        allowed.add(node.messageId);
      }
      continue;
    }
    // Without authenticated bot identity, addressed commands cannot establish a reset boundary.
    if (!isSelf && !params.botUsername && /^\/[^\s@]+@/u.test(node.body ?? "")) {
      continue;
    }
    if (
      !isSelf &&
      params.botUsername &&
      hasLeadingBotCommandAddressedToOtherBot(node.sourceMessage, params.botUsername)
    ) {
      continue;
    }
    const senderId = node.senderId ?? "";
    let effectiveGroupAllow = senderAccess.get(senderId);
    if (!effectiveGroupAllow) {
      effectiveGroupAllow = normalizeAllowFrom(
        await expandTelegramAllowFromWithAccessGroups({
          cfg: params.cfg,
          accountId: params.accountId,
          senderId,
          allowFrom,
        }),
      );
      senderAccess.set(senderId, effectiveGroupAllow);
    }
    if (
      !evaluateTelegramGroupBaseAccess({
        isGroup: true,
        groupConfig,
        topicConfig,
        effectiveGroupAllow,
        hasGroupAllowOverride: override !== undefined,
        senderId,
        enforceAllowOverride: !isSelf,
        requireSenderForAllowOverride: true,
      }).allowed ||
      !evaluateTelegramGroupPolicyAccess({
        isGroup: true,
        chatId: params.chatId,
        cfg: params.cfg,
        telegramCfg: params.telegramCfg,
        groupConfig,
        topicConfig,
        effectiveGroupAllow,
        senderId,
        enforcePolicy: true,
        enforceAllowlistAuthorization: !isSelf,
        allowEmptyAllowlistEntries: false,
        requireSenderForAllowlistAuthorization: true,
        checkChatAllowlist: true,
        resolveGroupPolicy: (chatId, cfg) =>
          resolveChannelGroupPolicy({
            cfg,
            channel: "telegram",
            accountId: params.accountId,
            groupId: String(chatId),
          }),
      }).allowed
    ) {
      continue;
    }
    // Self replies still obey room availability, but are not inbound user commands.
    if (isSelf) {
      allowed.add(node.messageId);
      continue;
    }
    if (hasControlCommand(node.body ?? "", params.cfg, { botUsername: params.botUsername })) {
      const gate = await resolveTelegramCommandIngressAuthorization({
        cfg: params.cfg,
        accountId: params.accountId,
        chatId: params.chatId,
        resolvedThreadId: params.threadSpec.id,
        senderId,
        isGroup: true,
        dmPolicy: "pairing",
        effectiveGroupAllow,
        effectiveDmAllow: normalizeAllowFrom([]),
        ownerAccess: { ownerList: [], senderIsOwner: false },
        eventKind: "message",
        allowTextCommands: true,
        hasControlCommand: true,
        modeWhenAccessGroupsOff: "allow",
        includeDmAllowForGroupCommands: false,
      });
      if (gate.shouldBlockControlCommand) {
        continue;
      }
    }
    allowed.add(node.messageId);
  }
  return allowed;
}
