import type {
  ChatMember,
  ReactionType,
  ReactionTypeCustomEmoji,
  ReactionTypeEmoji,
} from "grammy/types";
import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-helpers";
import { reportChannelRoomJoin } from "openclaw/plugin-sdk/channel-join-intro-runtime";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { readRuntimeConfig as getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, logVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { resolveTelegramAccount } from "./accounts.js";
import { normalizeAllowFrom } from "./bot-access.js";
import type { TelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import {
  buildSyntheticContext,
  buildSyntheticTextMessage,
} from "./bot-handlers.message-context.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import {
  createTelegramSpooledReplayDeferredParticipant,
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import { resolveTelegramBotHasTopicsEnabled, resolveTelegramThreadSpec } from "./bot/helpers.js";
import {
  applyTelegramTargetSession,
  resolveTelegramConversationRoute,
} from "./conversation-route.js";
import { evaluateTelegramGroupPolicyAccess } from "./group-access.js";
import { migrateTelegramGroupConfig } from "./group-migration.js";
import { getPreparedTelegramPollAnswer } from "./poll-answer-context.js";
import { findTelegramPollRegistryEntry, retireTelegramPollRegistryEntry } from "./poll-registry.js";
import { wasSentByBot } from "./sent-message-cache.js";

/** Stable operator-facing reason for a scoped reaction dropped without a known topic. */
const TELEGRAM_REACTION_THREAD_UNRESOLVED_REASON = "thread-context-unavailable";

type TelegramEventMessageDependencies = Pick<
  TelegramMessagePipeline,
  "resolveCachedMessageThreadSpec" | "processMessageWithReplyChain"
>;

type TelegramNotificationReaction = ReactionTypeEmoji | ReactionTypeCustomEmoji;

function isNotificationReaction(reaction: ReactionType): reaction is TelegramNotificationReaction {
  return reaction.type === "emoji" || reaction.type === "custom_emoji";
}

function reactionKey(reaction: TelegramNotificationReaction): string {
  return reaction.type === "emoji" ? reaction.emoji : `custom_emoji:${reaction.custom_emoji_id}`;
}

type CreateTelegramEventBindingsOptions = {
  params: RegisterTelegramHandlerParams;
  message: TelegramEventMessageDependencies;
  authorization: Pick<
    TelegramHandlerAuthorization,
    "resolveTelegramEventAuthorizationContext" | "authorizeTelegramEventSender"
  >;
};

function isCurrentTelegramChatMember(member: ChatMember): boolean {
  return (
    member.status === "creator" ||
    member.status === "administrator" ||
    member.status === "member" ||
    (member.status === "restricted" && member.is_member)
  );
}

export function createTelegramEventBindings({
  params,
  message,
  authorization,
}: CreateTelegramEventBindingsOptions) {
  const { accountId, ownerAgentId, bot, cfg, opts, runtime, shouldSkipUpdate } = params;
  const { authorizeTelegramEventSender, resolveTelegramEventAuthorizationContext } = authorization;
  const { processMessageWithReplyChain, resolveCachedMessageThreadSpec } = message;
  const resolveAuthorizedEventContext = async (
    eventParams: Parameters<typeof resolveTelegramEventAuthorizationContext>[0] & {
      senderId: string;
      chatTitle?: string;
      event: "reaction" | "poll_answer";
    },
  ) => {
    const context = await resolveTelegramEventAuthorizationContext(eventParams);
    if (!(await authorizeTelegramEventSender({ ...eventParams, mode: "reaction", context }))) {
      return undefined;
    }
    // Events carry no thread id; DM topics come from cached or persisted message context.
    const { groupConfig } = context;
    const requireTopic = groupConfig && "requireTopic" in groupConfig && groupConfig.requireTopic;
    if (!eventParams.isGroup && requireTopic === true && context.dmThreadId == null) {
      logVerbose(
        `Blocked telegram ${eventParams.event} in DM ${eventParams.chatId}: requireTopic=true but topic unknown`,
      );
      return undefined;
    }
    return context;
  };

  const registerChatMembership = () => {
    bot.on("my_chat_member", async (ctx) => {
      const membership = ctx.myChatMember;
      if (!membership || shouldSkipUpdate(ctx)) {
        return;
      }
      const botUserId = ctx.me?.id ?? opts.botInfo?.id;
      const isGroup = membership.chat.type === "group" || membership.chat.type === "supergroup";
      if (
        !isGroup ||
        botUserId === undefined ||
        membership.new_chat_member.user.id !== botUserId ||
        isCurrentTelegramChatMember(membership.old_chat_member) ||
        !isCurrentTelegramChatMember(membership.new_chat_member)
      ) {
        return;
      }

      const chatId = membership.chat.id;
      const threadSpec = resolveTelegramThreadSpec({
        isGroup: true,
        isForum: membership.chat.is_forum === true,
      });
      const currentCfg = getRuntimeConfig();
      const telegramCfg = resolveTelegramAccount({ cfg: currentCfg, accountId }).config;
      const { groupConfig, topicConfig } = params.resolveTelegramGroupConfig(
        chatId,
        threadSpec.id,
        currentCfg,
      );
      const groupPolicyAccess = evaluateTelegramGroupPolicyAccess({
        isGroup: true,
        chatId,
        cfg: currentCfg,
        telegramCfg,
        groupConfig,
        topicConfig,
        effectiveGroupAllow: normalizeAllowFrom(),
        resolveGroupPolicy: params.resolveGroupPolicy,
        enforceAllowlistAuthorization: false,
        allowEmptyAllowlistEntries: false,
      });
      const roomAllowed =
        groupConfig?.enabled !== false &&
        topicConfig?.enabled !== false &&
        groupPolicyAccess.allowed;
      const inviter = membership.from;
      const inviterLabel =
        [inviter.first_name, inviter.last_name].filter(Boolean).join(" ") || inviter.username;

      const participant = createTelegramSpooledReplayDeferredParticipant(`room-join:${chatId}`);
      const hold = participant?.beginSettlementHold();
      if (participant && !hold) {
        return;
      }
      try {
        const outcome = await reportChannelRoomJoin({
          cfg: currentCfg,
          channel: "telegram",
          accountId,
          conversationId: String(chatId),
          deliverTo: String(chatId),
          threadId: threadSpec.id,
          route: (
            await resolveTelegramConversationRoute({
              cfg: currentCfg,
              accountId,
              chatId,
              isGroup: true,
              threadSpec,
              topicAgentId: topicConfig?.agentId,
            })
          ).route,
          inviterLabel,
          roomAllowed,
          resolveRoomContext: async () => {
            const chat = await bot.api.getChat(chatId);
            // The Bot API exposes room metadata and pins, but cannot retrieve pre-join history.
            return {
              title: chat.title,
              purpose: chat.description,
              pinned: chat.pinned_message?.text ?? chat.pinned_message?.caption,
              historyUnavailable: true,
            };
          },
        });
        if (outcome.kind === "failed") {
          throw new Error(outcome.reason);
        }
        hold?.release("discard-pending");
        participant?.settle({ kind: "completed" });
      } catch (error) {
        hold?.release("replay-pending");
        participant?.settle({ kind: "failed-retryable", error });
        throw error;
      }
    });
  };

  const registerReaction = () => {
    bot.on("message_reaction", async (ctx) => {
      try {
        const reaction = ctx.messageReaction;
        if (!reaction || shouldSkipUpdate(ctx)) {
          return;
        }

        const chatId = reaction.chat.id;
        const messageId = reaction.message_id;
        const user = reaction.user;
        const senderId = user?.id != null ? String(user.id) : "";
        const isGroup = reaction.chat.type === "group" || reaction.chat.type === "supergroup";
        const isDirectMessagesChat = reaction.chat.is_direct_messages === true;
        const isForum = isGroup && !isDirectMessagesChat && reaction.chat.is_forum === true;
        const authorizationCfg = getRuntimeConfig();
        const authorizationTelegramCfg = resolveTelegramAccount({
          cfg: authorizationCfg,
          accountId,
        }).config;

        const reactionMode = authorizationTelegramCfg.reactionNotifications ?? "own";
        if (reactionMode === "off" || user?.is_bot) {
          return;
        }
        if (
          reactionMode === "own" &&
          !(await wasSentByBot(chatId, messageId, authorizationCfg, {
            accountId,
            agentId: ownerAgentId,
          }))
        ) {
          logVerbose(
            `telegram: skipped reaction on msg ${messageId} in chat ${chatId} (own mode, not sent by bot)`,
          );
          return;
        }

        // Detect additions before topic recovery so no-op reactions avoid cache work and warnings.
        const oldReactions = new Set(
          reaction.old_reaction.filter(isNotificationReaction).map(reactionKey),
        );
        const addedReactions = reaction.new_reaction
          .filter(isNotificationReaction)
          .filter((item) => !oldReactions.has(reactionKey(item)));
        if (addedReactions.length === 0) {
          return;
        }

        // Reaction updates omit every topic field. Scoped reactions require the bounded cache;
        // private-chat reactions use it when present and otherwise stay on the base DM.
        const requiredScope = isDirectMessagesChat
          ? "direct-messages"
          : isForum
            ? "forum"
            : undefined;
        const cached =
          requiredScope || reaction.chat.type === "private"
            ? await resolveCachedMessageThreadSpec({ chatId, messageId })
            : undefined;
        const recoveredThreadSpec =
          cached?.threadSpec.scope === (requiredScope ?? "dm") && cached.threadSpec.id !== undefined
            ? cached.threadSpec
            : undefined;
        if (requiredScope && !recoveredThreadSpec) {
          runtime.log?.(
            warn(
              `telegram: skipped scoped reaction account=${accountId} chat=${chatId} message=${messageId} reason=${TELEGRAM_REACTION_THREAD_UNRESOLVED_REASON}`,
            ),
          );
          return;
        }

        const eventAuthContext = await resolveAuthorizedEventContext({
          cfg: authorizationCfg,
          chatId,
          chatTitle: reaction.chat.title,
          isGroup,
          senderId,
          event: "reaction",
          threadSpec:
            recoveredThreadSpec ??
            resolveTelegramThreadSpec({
              isGroup,
              isForum,
            }),
        });
        if (!eventAuthContext) {
          return;
        }

        let { route } = await resolveTelegramConversationRoute({
          cfg: eventAuthContext.cfg,
          accountId,
          chatId,
          isGroup,
          threadSpec: recoveredThreadSpec ?? eventAuthContext.threadSpec,
          senderId,
          topicAgentId: eventAuthContext.topicConfig?.agentId,
        });
        if (recoveredThreadSpec?.scope === "dm") {
          route = applyTelegramTargetSession({
            cfg: eventAuthContext.cfg,
            route,
            chatId,
            isGroup,
            senderId,
            dmThreadId: recoveredThreadSpec.id,
            // Like messages, a cached topic message proves topics before a stale getMe does.
            botHasTopicsEnabled:
              cached?.isTopicMessage === true || resolveTelegramBotHasTopicsEnabled(ctx.me),
          });
        }

        const senderName = user
          ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username
          : undefined;
        const senderUsernameLabel = user?.username ? `@${user.username}` : undefined;
        const senderLabel =
          (senderName && senderUsernameLabel
            ? `${senderName} (${senderUsernameLabel})`
            : senderName || senderUsernameLabel) || (user?.id ? `id:${user.id}` : "unknown");

        for (const addedReaction of addedReactions) {
          const emoji =
            addedReaction.type === "emoji"
              ? addedReaction.emoji
              : `custom emoji ${addedReaction.custom_emoji_id}`;
          const text = `Telegram reaction added: ${emoji} by ${senderLabel} on msg ${messageId}`;
          enqueueRoutedSystemEvent(text, route, {
            contextKey: `telegram:reaction:add:${chatId}:${messageId}:${user?.id ?? "anon"}:${reactionKey(addedReaction)}`,
          });
        }
      } catch (err) {
        runtime.error?.(danger(`telegram reaction handler failed: ${String(err)}`));
        throw err;
      }
    });
  };

  const handlePollError = (
    err: unknown,
    ctx: { update: unknown },
    kind: "poll" | "poll_answer",
  ) => {
    runtime.error?.(danger(`telegram ${kind} handler failed: ${String(err)}`));
    if (isTelegramSpooledReplayUpdate(ctx.update)) {
      recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
    } else {
      throw err;
    }
  };

  const registerPolls = () => {
    bot.on("poll", async (ctx) => {
      try {
        const poll = ctx.poll;
        if (!poll?.is_closed || shouldSkipUpdate(ctx)) {
          return;
        }
        await retireTelegramPollRegistryEntry({ accountId, pollId: poll.id });
      } catch (err) {
        handlePollError(err, ctx, "poll");
      }
    });

    // Public poll answers omit chat/thread data. The send path persists that origin.
    bot.on("poll_answer", async (ctx) => {
      try {
        const pollAnswer = ctx.pollAnswer;
        if (!pollAnswer || shouldSkipUpdate(ctx)) {
          return;
        }
        const optionIds = pollAnswer.option_ids ?? [];
        const user = pollAnswer.user;
        // Retractions and voters without a usable user identity cannot pass authorization.
        if (optionIds.length === 0 || !user || user.is_bot) {
          return;
        }

        // Store failures replay durable ingress; only a true miss is a safe no-op.
        const pollId = pollAnswer.poll_id;
        const prepared = getPreparedTelegramPollAnswer(ctx.update);
        const entry = prepared
          ? prepared.entry
          : await findTelegramPollRegistryEntry({ pollId, accountId });
        if (!entry) {
          logVerbose(`telegram: poll_answer for poll ${pollId} has no registry entry; skipping`);
          return;
        }

        const chatId = entry.chat.id;
        const isGroup = entry.chat.type === "group" || entry.chat.type === "supergroup";
        const senderId = String(user.id);
        if (!isGroup && user.id !== chatId) {
          logVerbose(`Blocked forwarded telegram poll_answer for DM ${chatId} from ${senderId}`);
          return;
        }
        if (isGroup && !isCurrentTelegramChatMember(await bot.api.getChatMember(chatId, user.id))) {
          logVerbose(
            `Blocked forwarded telegram poll_answer for group ${chatId} from non-member ${senderId}`,
          );
          return;
        }
        const authorizationCfg = getRuntimeConfig();
        const eventAuthContext = await resolveAuthorizedEventContext({
          cfg: authorizationCfg,
          chatId,
          chatTitle: "title" in entry.chat ? entry.chat.title : undefined,
          isGroup,
          senderId,
          threadSpec: entry.threadSpec,
          event: "poll_answer",
        });
        if (!eventAuthContext) {
          return;
        }

        const optionLabels = optionIds.map((index) => entry.options[index] ?? `option ${index}`);
        const text = `Poll response to "${entry.question}": ${optionLabels.join(", ")}`;
        const messageThreadId = "id" in entry.threadSpec ? entry.threadSpec.id : undefined;
        const syntheticMessage = buildSyntheticTextMessage({
          base: {
            message_id: entry.messageId,
            date: Math.floor(Date.now() / 1000),
            chat: entry.chat,
            ...(messageThreadId == null
              ? {}
              : {
                  message_thread_id: messageThreadId,
                  is_topic_message: true,
                }),
          },
          from: user,
          text,
        });
        const result = await processMessageWithReplyChain({
          ctx: buildSyntheticContext(ctx, syntheticMessage),
          msg: syntheticMessage,
          allMedia: [],
          storeAllowFrom: eventAuthContext.storeAllowFrom,
          options: {
            forceWasMentioned: true,
            messageIdOverride:
              typeof ctx.update.update_id === "number"
                ? String(ctx.update.update_id)
                : `poll:${pollId}:${user.id}:${optionIds.join("-")}`,
          },
        });
        recordTelegramMessageProcessingResult(result);
      } catch (err) {
        handlePollError(err, ctx, "poll_answer");
      }
    });
  };

  const registerMigration = () => {
    bot.on("message:migrate_to_chat_id", async (ctx) => {
      try {
        const msg = ctx.message;
        if (!msg?.migrate_to_chat_id || shouldSkipUpdate(ctx)) {
          return;
        }

        const oldChatId = String(msg.chat.id);
        const newChatId = String(msg.migrate_to_chat_id);
        const chatTitle = msg.chat.title ?? "Unknown";
        runtime.log?.(
          warn(`[telegram] Group migrated: "${chatTitle}" ${oldChatId} → ${newChatId}`),
        );

        if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
          runtime.log?.(
            warn("[telegram] Config writes disabled; skipping group config migration."),
          );
          return;
        }

        const currentConfig = getRuntimeConfig();
        const migration = migrateTelegramGroupConfig({
          cfg: currentConfig,
          accountId,
          oldChatId,
          newChatId,
        });

        if (migration.migrated) {
          runtime.log?.(
            warn(`[telegram] Migrating group config from ${oldChatId} to ${newChatId}`),
          );
          migrateTelegramGroupConfig({ cfg, accountId, oldChatId, newChatId });
          await mutateConfigFile({
            afterWrite: { mode: "auto" },
            mutate: (draft) => {
              migrateTelegramGroupConfig({ cfg: draft, accountId, oldChatId, newChatId });
            },
          });
          runtime.log?.(warn("[telegram] Group config migrated and saved successfully"));
        } else if (migration.skippedExisting) {
          runtime.log?.(
            warn(
              `[telegram] Group config already exists for ${newChatId}; leaving ${oldChatId} unchanged`,
            ),
          );
        } else {
          runtime.log?.(
            warn(`[telegram] No config found for old group ID ${oldChatId}, migration logged only`),
          );
        }
      } catch (err) {
        runtime.error?.(danger(`[telegram] Group migration handler failed: ${String(err)}`));
        throw err;
      }
    });
  };

  return {
    registerChatMembership,
    registerReaction,
    registerPolls,
    registerMigration,
  };
}
