const FEISHU_SYNTHETIC_REACTION_SEPARATOR = ":reaction:";

/**
 * Return the Open Message ID accepted by Feishu APIs.
 *
 * Feishu reaction notifications are represented internally as synthetic message
 * events by appending `:reaction:<emoji>:<uuid>` to the reacted message ID. That
 * suffix is useful for OpenClaw turn/dedupe identity, but Feishu APIs only
 * accept the base open_message_id.
 */
export function normalizeFeishuOpenMessageId(messageId: string): string {
  const trimmed = messageId.trim();
  const reactionIndex = trimmed.indexOf(FEISHU_SYNTHETIC_REACTION_SEPARATOR);
  if (reactionIndex <= 0) {
    return trimmed;
  }
  return trimmed.slice(0, reactionIndex);
}
