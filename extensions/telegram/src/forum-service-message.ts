const TELEGRAM_FORUM_SERVICE_FIELDS = [
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden",
] as const;

// Forum service messages must not trigger implicit reply-to-bot mentions.
export function isTelegramForumServiceMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") {
    return false;
  }
  const messageRecord = msg as Record<(typeof TELEGRAM_FORUM_SERVICE_FIELDS)[number], unknown>;
  return TELEGRAM_FORUM_SERVICE_FIELDS.some(
    (field) => field in messageRecord && messageRecord[field] != null,
  );
}
