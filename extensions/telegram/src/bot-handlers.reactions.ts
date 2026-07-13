import type { ReactionTypeEmoji } from "grammy/types";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveTelegramAccount } from "./accounts.js";
import type { TelegramEventAuthorizationRuntime } from "./bot-handlers.event-authorization.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  resolveTelegramForumThreadId,
} from "./bot/helpers.js";

export function registerTelegramReactionHandler(
  params: Pick<
    RegisterTelegramHandlerParams,
    "accountId" | "bot" | "runtime" | "shouldSkipUpdate" | "telegramDeps"
  >,
  authorization: TelegramEventAuthorizationRuntime,
) {
  const { accountId, bot, runtime, shouldSkipUpdate, telegramDeps } = params;

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
      const senderUsername = user?.username ?? "";
      const isGroup = reaction.chat.type === "group" || reaction.chat.type === "supergroup";
      const isForum = reaction.chat.is_forum === true;
      const cfg = telegramDeps.getRuntimeConfig();
      const telegramCfg = resolveTelegramAccount({ cfg, accountId }).config;

      const reactionMode = telegramCfg.reactionNotifications ?? "own";
      if (reactionMode === "off" || user?.is_bot) {
        return;
      }
      if (reactionMode === "own" && !telegramDeps.wasSentByBot(chatId, messageId, cfg)) {
        logVerbose(
          `telegram: skipped reaction on msg ${messageId} in chat ${chatId} (own mode, not sent by bot)`,
        );
        return;
      }

      const eventAuthContext = await authorization.resolveContext({
        cfg,
        chatId,
        isGroup,
        isForum,
        senderId,
      });
      if (
        !(await authorization.authorizeSender({
          chatId,
          chatTitle: reaction.chat.title,
          isGroup,
          senderId,
          senderUsername,
          mode: "reaction",
          context: eventAuthContext,
        }))
      ) {
        return;
      }

      // Telegram omits the topic id from reactions, so requireTopic DMs cannot be authorized.
      if (
        !isGroup &&
        (eventAuthContext.groupConfig as { requireTopic?: boolean } | undefined)?.requireTopic ===
          true
      ) {
        logVerbose(
          `Blocked telegram reaction in DM ${chatId}: requireTopic=true but topic unknown for reactions`,
        );
        return;
      }

      const oldEmojis = new Set(
        reaction.old_reaction
          .filter((item): item is ReactionTypeEmoji => item.type === "emoji")
          .map((item) => item.emoji),
      );
      const addedReactions = reaction.new_reaction
        .filter((item): item is ReactionTypeEmoji => item.type === "emoji")
        .filter((item) => !oldEmojis.has(item.emoji));
      if (addedReactions.length === 0) {
        return;
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
      senderLabel ||= "unknown";

      // Reaction payloads lack message_thread_id, so forum reactions use the chat session.
      const resolvedThreadId = isForum
        ? resolveTelegramForumThreadId({ isForum, messageThreadId: undefined })
        : undefined;
      const peerId = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId);
      const route = resolveAgentRoute({
        cfg: eventAuthContext.cfg,
        channel: "telegram",
        accountId,
        peer: { kind: isGroup ? "group" : "direct", id: peerId },
        parentPeer: buildTelegramParentPeer({ isGroup, resolvedThreadId, chatId }),
      });

      for (const addedReaction of addedReactions) {
        const emoji = addedReaction.emoji;
        const text = `Telegram reaction added: ${emoji} by ${senderLabel} on msg ${messageId}`;
        telegramDeps.enqueueSystemEvent(text, {
          sessionKey: route.sessionKey,
          contextKey: `telegram:reaction:add:${chatId}:${messageId}:${user?.id ?? "anon"}:${emoji}`,
        });
        logVerbose(`telegram: reaction event enqueued: ${text}`);
      }
    } catch (err) {
      runtime.error?.(danger(`telegram reaction handler failed: ${String(err)}`));
      throw err;
    }
  });
}
