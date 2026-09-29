import type { Message } from "grammy/types";
import {
  getTopicCreatorUserId,
  getTopicName,
  recordTopicCreation,
  updateTopicName,
} from "./topic-name-cache.js";

export async function resolveTelegramForumTopicMetadata(params: {
  msg: Message;
  threadId: number;
  scope: string;
}): Promise<{ topicName: string | undefined; creatorUserId: number | undefined }> {
  const { msg, threadId, scope } = params;
  const chatId = msg.chat.id;
  const created = msg.forum_topic_created;
  if (created?.name) {
    await recordTopicCreation(
      chatId,
      threadId,
      {
        name: created.name,
        creatorUserId: msg.from?.id,
        iconColor: created.icon_color,
        iconCustomEmojiId: created.icon_custom_emoji_id,
      },
      scope,
    );
  }
  const edited = msg.forum_topic_edited;
  const patch = edited?.name
    ? { name: edited.name, iconCustomEmojiId: edited.icon_custom_emoji_id }
    : msg.forum_topic_closed
      ? { closed: true }
      : msg.forum_topic_reopened
        ? { closed: false }
        : undefined;
  if (patch) {
    await updateTopicName(chatId, threadId, patch, scope);
  }

  let topicName = await getTopicName(chatId, threadId, scope);
  let creatorUserId = await getTopicCreatorUserId(chatId, threadId, scope);
  const reply = msg.reply_to_message;
  const replyCreated = reply?.forum_topic_created;
  if (reply && replyCreated?.name) {
    const replyCreatorUserId = reply.message_id === threadId ? reply.from?.id : undefined;
    if (!topicName || (creatorUserId === undefined && replyCreatorUserId !== undefined)) {
      await recordTopicCreation(
        chatId,
        threadId,
        {
          name: replyCreated.name,
          iconColor: replyCreated.icon_color,
          iconCustomEmojiId: replyCreated.icon_custom_emoji_id,
          creatorUserId: replyCreatorUserId,
        },
        scope,
      );
      topicName ??= replyCreated.name;
      creatorUserId ??= replyCreatorUserId;
    }
  }
  return { topicName, creatorUserId };
}
