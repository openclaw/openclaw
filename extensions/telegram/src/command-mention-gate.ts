import type { Message } from "grammy/types";
import { firstDefined } from "openclaw/plugin-sdk/allow-from";
import {
  buildMentionRegexes,
  implicitMentionKindWhen,
  matchesMentionWithExplicit,
  resolveGroupThreadMentionFacts,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveBotThreadMentionPolicy } from "openclaw/plugin-sdk/channel-mention-gating";
import {
  buildChannelGroupsScopeTree,
  resolveScopeRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getSessionEntryAsync, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { mergeTelegramAccountConfig } from "./account-config.js";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { getTelegramTextParts, hasBotMention } from "./bot/body-helpers.js";
import {
  buildTelegramGroupPeerId,
  resolveTelegramMessageThreadSpec,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import {
  inspectTelegramConversationRoute,
  resolveTelegramTargetSession,
} from "./conversation-route.js";
import { isTelegramForumServiceMessage } from "./forum-service-message.js";
import { resolveTelegramForumTopicMetadata } from "./forum-topic-metadata.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";

/** Command paths must make the same group activation decision before dispatch or cancellation. */
export async function isTelegramCommandAddressed(params: {
  cfg: OpenClawConfig;
  accountId: string;
  msg: Message;
  botUsername?: string;
  botId?: number;
  threadSpec?: TelegramThreadSpec;
  requireMentionOverride?: boolean;
  ownerAgentId?: string;
}): Promise<boolean> {
  const { cfg, accountId, msg } = params;
  const isGroup =
    msg.chat.is_direct_messages !== true &&
    (msg.chat.type === "group" || msg.chat.type === "supergroup");
  if (!isGroup) {
    return true;
  }
  const chatId = msg.chat.id;
  const threadSpec = params.threadSpec ?? resolveTelegramMessageThreadSpec(msg);
  const { groupConfig, topicConfig } = resolveTelegramScopedGroupConfig(
    mergeTelegramAccountConfig(cfg, accountId),
    chatId,
    threadSpec.id,
  );
  const { route, bindingMode } = inspectTelegramConversationRoute({
    cfg,
    accountId,
    chatId,
    isGroup: true,
    threadSpec,
    senderId: msg.from?.id ? String(msg.from.id) : "",
    topicAgentId: topicConfig?.agentId,
  });
  if (bindingMode.kind === "plugin-owned-runtime") {
    return true;
  }
  const sessionKey = resolveTelegramTargetSession({ cfg, route, chatId, isGroup: true });
  let activationOverride: boolean | undefined;
  try {
    const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
    const activation = (await getSessionEntryAsync({ storePath, sessionKey }))?.groupActivation;
    activationOverride =
      activation === "mention" ? true : activation === "always" ? false : undefined;
  } catch (err) {
    logVerbose(`Failed to load session for command activation check: ${String(err)}`);
  }
  const configuredRequireMention = firstDefined(
    topicConfig?.requireMention,
    activationOverride,
    groupConfig && "requireMention" in groupConfig ? groupConfig.requireMention : undefined,
    resolveScopeRequireMention({
      tree: buildChannelGroupsScopeTree(cfg, "telegram", accountId),
      path: [String(chatId)],
      requireMentionOverride: params.requireMentionOverride,
      overrideOrder: "after-config",
    }),
  );
  const requireMentionInBotThreads = firstDefined(
    topicConfig &&
      "requireMentionInBotThreads" in topicConfig &&
      typeof topicConfig.requireMentionInBotThreads === "boolean"
      ? topicConfig.requireMentionInBotThreads
      : undefined,
    groupConfig &&
      "requireMentionInBotThreads" in groupConfig &&
      typeof groupConfig.requireMentionInBotThreads === "boolean"
      ? groupConfig.requireMentionInBotThreads
      : undefined,
  );
  let isBotOwnedThread = false;
  if (
    threadSpec.scope === "forum" &&
    threadSpec.id != null &&
    requireMentionInBotThreads !== undefined
  ) {
    const ownerAgentId =
      params.ownerAgentId?.trim() || resolveTelegramAccountOwnerAgentId({ cfg, accountId });
    const topic = await resolveTelegramForumTopicMetadata({
      msg,
      threadId: threadSpec.id,
      scope: resolveStorePath(cfg.session?.store, {
        agentId: ownerAgentId,
      }),
    });
    isBotOwnedThread = params.botId != null && params.botId === topic.creatorUserId;
  }
  const replyToBot =
    params.botId != null &&
    msg.reply_to_message?.from?.id === params.botId &&
    !isTelegramForumServiceMessage(msg.reply_to_message);
  const { requireMention, implicitMentionKinds } = resolveBotThreadMentionPolicy({
    isBotOwnedThread,
    requireMentionInBotThreads,
    requireMention: Boolean(configuredRequireMention),
    implicitMentionKinds: implicitMentionKindWhen("reply_to_bot", replyToBot),
  });
  if (!requireMention) {
    return true;
  }
  const botUsername = params.botUsername?.trim().toLowerCase();
  const textParts = getTelegramTextParts(msg);
  const groupThread = resolveGroupThreadMentionFacts({
    cfg,
    channel: "telegram",
    // Broadcast participation is configured at the group peer, even when the
    // incoming command belongs to a forum topic. Match canonical body admission.
    peerId: String(chatId),
    text: textParts.text,
    sessionKey,
    acpBinding: bindingMode.kind === "configured",
  });
  const mentionRegexes = buildMentionRegexes(cfg, route.agentId, {
    provider: "telegram",
    conversationId: buildTelegramGroupPeerId(chatId, threadSpec),
    providerPolicy: cfg.channels?.telegram?.accounts?.[accountId]?.mentionPatterns,
  });
  const hasAnyMention = textParts.entities.some((entity) => entity.type === "mention");
  const wasMentioned =
    Boolean(groupThread?.mentionedAgentIds.length) ||
    matchesMentionWithExplicit({
      text: textParts.text,
      mentionRegexes,
      explicit: {
        hasAnyMention,
        isExplicitlyMentioned: botUsername ? hasBotMention(msg, botUsername, params.botId) : false,
        canResolveExplicit: Boolean(botUsername),
      },
    });
  return !resolveInboundMentionDecision({
    facts: { canDetectMention: true, wasMentioned, hasAnyMention, implicitMentionKinds },
    policy: {
      isGroup: true,
      requireMention: true,
      allowTextCommands: false,
      hasControlCommand: true,
      commandAuthorized: false,
    },
  }).shouldSkip;
}
