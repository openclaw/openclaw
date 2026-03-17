const TELEGRAM_FORUM_SERVICE_FIELDS = [
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden"
];
function isTelegramForumServiceMessage(msg) {
  if (!msg || typeof msg !== "object") {
    return false;
  }
  const record = msg;
  return TELEGRAM_FORUM_SERVICE_FIELDS.some((field) => record[field] != null);
}
export {
  TELEGRAM_FORUM_SERVICE_FIELDS,
  isTelegramForumServiceMessage
};
