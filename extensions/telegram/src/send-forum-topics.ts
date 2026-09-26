import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  createTelegramNonIdempotentRequestWithDiag,
  resolveAndPersistChatId,
  withTelegramApiContext,
  type TelegramApiContext,
} from "./send-context.js";
import type { TelegramApiCallOpts, TelegramMessageActionOpts } from "./send-message-types.js";
import { prepareTelegramOutbound } from "./send-outbound.js";
import { parseTelegramTarget } from "./targets.js";

type TelegramCreateForumTopicParams = NonNullable<
  Parameters<TelegramApiContext["api"]["createForumTopic"]>[2]
>;

type TelegramEditForumTopicOpts = TelegramMessageActionOpts & {
  name?: string;
  iconCustomEmojiId?: string;
};

export async function editForumTopicTelegram(
  chatIdInput: string | number,
  messageThreadIdInput: string | number,
  opts: TelegramEditForumTopicOpts,
): Promise<{
  ok: true;
  chatId: string;
  messageThreadId: number;
  name?: string;
  iconCustomEmojiId?: string;
}> {
  const nameProvided = opts.name !== undefined;
  const trimmedName = opts.name?.trim();
  if (nameProvided && !trimmedName) {
    throw new Error("Telegram forum topic name is required");
  }
  if (trimmedName && Array.from(trimmedName).length > 128) {
    throw new Error("Telegram forum topic name must be 128 characters or fewer");
  }
  const iconProvided = opts.iconCustomEmojiId !== undefined;
  const trimmedIconCustomEmojiId = opts.iconCustomEmojiId?.trim();
  if (iconProvided && !trimmedIconCustomEmojiId) {
    throw new Error("Telegram forum topic icon custom emoji ID is required");
  }
  if (!trimmedName && !trimmedIconCustomEmojiId) {
    throw new Error("Telegram forum topic update requires a name or iconCustomEmojiId");
  }

  return withTelegramApiContext(
    opts,
    async (
      context,
    ): Promise<{
      ok: true;
      chatId: string;
      messageThreadId: number;
      name?: string;
      iconCustomEmojiId?: string;
    }> => {
      const { api } = context;
      const {
        chatId,
        messageId: messageThreadId,
        request,
      } = await prepareTelegramOutbound({
        to: chatIdInput,
        context,
        opts,
        messageIdInput: messageThreadIdInput,
        request: { kind: "standard" },
      });
      const payload = {
        ...(trimmedName ? { name: trimmedName } : {}),
        ...(trimmedIconCustomEmojiId ? { icon_custom_emoji_id: trimmedIconCustomEmojiId } : {}),
      };
      await request(() => api.editForumTopic(chatId, messageThreadId, payload), "editForumTopic");
      logVerbose(`[telegram] Edited forum topic ${messageThreadId} in chat ${chatId}`);
      return {
        ok: true,
        chatId,
        messageThreadId,
        ...(trimmedName ? { name: trimmedName } : {}),
        ...(trimmedIconCustomEmojiId ? { iconCustomEmojiId: trimmedIconCustomEmojiId } : {}),
      };
    },
  );
}

export async function renameForumTopicTelegram(
  chatIdInput: string | number,
  messageThreadIdInput: string | number,
  name: string,
  opts: TelegramMessageActionOpts,
): Promise<{ ok: true; chatId: string; messageThreadId: number; name: string }> {
  const result = await editForumTopicTelegram(chatIdInput, messageThreadIdInput, {
    ...opts,
    name,
  });
  return {
    ok: true,
    chatId: result.chatId,
    messageThreadId: result.messageThreadId,
    name: result.name ?? name.trim(),
  };
}

// ---------------------------------------------------------------------------
// Forum topic creation
// ---------------------------------------------------------------------------

type TelegramCreateForumTopicOpts = TelegramApiCallOpts &
  Pick<TelegramMessageActionOpts, "assertPlatformSendAuthorized"> & {
    /** Icon color for the topic (must be one of 0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F). */
    iconColor?: TelegramCreateForumTopicParams["icon_color"];
    /** Custom emoji ID for the topic icon. */
    iconCustomEmojiId?: string;
  };

type TelegramCreateForumTopicResult = {
  topicId: number;
  name: string;
  chatId: string;
};

/**
 * Create a forum topic in a Telegram supergroup.
 * Requires the bot to have `can_manage_topics` permission.
 *
 * @param chatId - Supergroup chat ID
 * @param name - Topic name (1-128 characters)
 * @param opts - Optional configuration
 */
export async function createForumTopicTelegram(
  chatId: string,
  name: string,
  opts: TelegramCreateForumTopicOpts,
): Promise<TelegramCreateForumTopicResult> {
  const assertPlatformSendAuthorized = opts.assertPlatformSendAuthorized;
  if (!name?.trim()) {
    throw new Error("Forum topic name is required");
  }
  const trimmedName = name.trim();
  if (Array.from(trimmedName).length > 128) {
    throw new Error("Forum topic name must be 128 characters or fewer");
  }

  return withTelegramApiContext(
    { ...opts, assertPlatformSendAuthorized },
    async (context): Promise<TelegramCreateForumTopicResult> => {
      const { cfg, account, api } = context;
      // Accept topic-qualified targets (e.g. telegram:group:<id>:topic:<thread>)
      // but createForumTopic must always target the base supergroup chat id.
      const target = parseTelegramTarget(chatId);
      const normalizedChatId = await resolveAndPersistChatId({
        cfg,
        api,
        lookupTarget: target.chatId,
        persistTarget: chatId,
        verbose: opts.verbose,
        gatewayClientScopes: opts.gatewayClientScopes,
      });

      const requestWithDiag = createTelegramNonIdempotentRequestWithDiag({
        cfg,
        retry: opts.retry,
        verbose: opts.verbose,
      });

      const extra: TelegramCreateForumTopicParams = {};
      if (opts.iconColor != null) {
        extra.icon_color = opts.iconColor;
      }
      if (opts.iconCustomEmojiId?.trim()) {
        extra.icon_custom_emoji_id = opts.iconCustomEmojiId.trim();
      }

      const hasExtra = Object.keys(extra).length > 0;
      const result = await requestWithDiag(() => {
        assertPlatformSendAuthorized?.();
        return api.createForumTopic(normalizedChatId, trimmedName, hasExtra ? extra : undefined);
      }, "createForumTopic");

      const topicId = result.message_thread_id;

      recordChannelActivity({
        channel: "telegram",
        accountId: account.accountId,
        direction: "outbound",
      });

      return {
        topicId,
        name: result.name ?? trimmedName,
        chatId: normalizedChatId,
      };
    },
  );
}
