// Telegram public-poll answer handler registration.
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramHandlerAuthorizationRuntime } from "./bot-handlers.authorization.runtime.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import { resolveTelegramForumFlag } from "./bot/helpers.js";
import { resolveTelegramConversationRoute } from "./conversation-route.js";
import { findTelegramPollRegistryEntry } from "./poll-registry.js";

export function registerTelegramPollAnswerHandler(
  {
    accountId,
    bot,
    runtime,
    telegramDeps,
    resolveTelegramGroupConfig,
    shouldSkipUpdate,
  }: RegisterTelegramHandlerParams,
  authorizationRuntime: TelegramHandlerAuthorizationRuntime,
) {
  const { resolveTelegramEventAuthorizationContext, authorizeTelegramEventSender } =
    authorizationRuntime;

  // Telegram emits poll_answer only for non-anonymous polls, and the update omits
  // chat/thread data. The send path records that origin in the keyed plugin store.
  bot.on("poll_answer", async (ctx) => {
    try {
      const pollAnswer = ctx.pollAnswer;
      if (!pollAnswer || shouldSkipUpdate(ctx)) {
        return;
      }
      const optionIds = pollAnswer.option_ids ?? [];
      const user = pollAnswer.user;
      // Retractions have no selection to route. Bot voters and voter_chat-only
      // answers have no user identity that can pass the sender authorization gate.
      if (optionIds.length === 0 || !user || user.is_bot) {
        return;
      }

      // A true miss is a safe no-op. Store failures throw so durable ingress can
      // release the claim and replay instead of permanently dropping the vote.
      const pollId = pollAnswer.poll_id;
      const entry = await findTelegramPollRegistryEntry({ pollId, accountId });
      if (!entry) {
        logVerbose(`telegram: poll_answer for poll ${pollId} has no registry entry; skipping`);
        return;
      }

      const chatId = Number(entry.chatId);
      const isGroup = entry.chatId.startsWith("-");
      const isForum = isGroup
        ? await resolveTelegramForumFlag({
            chatId,
            chatType: "supergroup",
            isGroup,
            getChat: bot.api.getChat.bind(bot.api),
          })
        : false;
      const senderId = user?.id != null ? String(user.id) : "";
      const senderUsername = user?.username ?? "";
      const authorizationCfg = telegramDeps.getRuntimeConfig();
      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        cfg: authorizationCfg,
        chatId,
        isGroup,
        isForum,
        senderId,
        messageThreadId: entry.messageThreadId,
      });
      const senderAuthorization = await authorizeTelegramEventSender({
        chatId,
        isGroup,
        senderId,
        senderUsername,
        // Poll votes and reactions are both user-originated updates attached to
        // bot-created UI, so they share the reaction authorization boundary.
        mode: "reaction",
        context: eventAuthContext,
      });
      if (!senderAuthorization) {
        return;
      }

      // poll_answer has no thread id. A DM poll without persisted topic context
      // cannot satisfy requireTopic and must not wake the base DM session.
      if (!isGroup) {
        const requireTopic = (
          eventAuthContext.groupConfig as { requireTopic?: boolean } | undefined
        )?.requireTopic;
        if (requireTopic === true && eventAuthContext.dmThreadId == null) {
          logVerbose(
            `Blocked telegram poll_answer in DM ${chatId}: requireTopic=true but topic unknown`,
          );
          return;
        }
      }

      const senderName = user
        ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username
        : undefined;
      const senderUsernameLabel = user?.username ? `@${user.username}` : undefined;
      let senderLabel = senderName;
      if (senderName && senderUsernameLabel) {
        senderLabel = `${senderName} (${senderUsernameLabel})`;
      } else if (!senderName && senderUsernameLabel) {
        senderLabel = senderUsernameLabel;
      }
      if (!senderLabel && user?.id) {
        senderLabel = `id:${user.id}`;
      }
      senderLabel = senderLabel || "unknown";

      const optionLabels = optionIds.map((index) => entry.options[index] ?? `option ${index}`);
      const text = `Telegram poll vote: "${entry.question}" — ${senderLabel} voted: ${optionLabels.join(
        ", ",
      )}`;
      const resolvedThreadId = eventAuthContext.resolvedThreadId;
      const routeThreadId =
        resolvedThreadId ?? eventAuthContext.dmThreadId ?? entry.messageThreadId;
      const { topicConfig } = resolveTelegramGroupConfig(
        chatId,
        routeThreadId,
        eventAuthContext.cfg,
      );
      const { route } = resolveTelegramConversationRoute({
        cfg: eventAuthContext.cfg,
        accountId,
        chatId,
        isGroup,
        resolvedThreadId,
        replyThreadId: routeThreadId,
        senderId,
        topicAgentId: topicConfig?.agentId,
      });

      telegramDeps.enqueueSystemEvent(text, {
        sessionKey: route.sessionKey,
        contextKey: `telegram:poll_answer:${pollId}:${user?.id ?? "anon"}:${optionIds.join("-")}`,
      });
      logVerbose(`telegram: poll_answer event enqueued for poll ${pollId} by ${senderLabel}`);
    } catch (err) {
      runtime.error?.(danger(`telegram poll_answer handler failed: ${String(err)}`));
      if (isTelegramSpooledReplayUpdate(ctx.update)) {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
        return;
      }
      throw err;
    }
  });
}
