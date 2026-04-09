/**
 * Returns true when a Feishu message event should be treated as a group chat.
 *
 * Feishu OpenChat entities (topic groups / 话题群) have a `chat_id` starting
 * with `"oc_"` but report `chat_type` as `"p2p"` in bot-receive events.
 * Routing logic must treat these as group chats so messages are dispatched to
 * the configured channel session rather than the main agent session.
 *
 * @param chatType The raw `chat_type` value from the Feishu event.
 * @param chatId   The raw `chat_id` value from the Feishu event.
 */
export function isFeishuGroupChat(chatType: unknown, chatId: unknown): boolean {
  if (chatType === "group") return true;
  if (chatType !== "p2p") return false;
  return typeof chatId === "string" && chatId.startsWith("oc_");
}
