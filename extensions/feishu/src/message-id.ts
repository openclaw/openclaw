const FEISHU_REACTION_MESSAGE_ID_SUFFIX_RE =
  /:reaction:[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Synthetic reaction events use IDs like:
 *   om_xxx:reaction:THUMBSUP:uuid
 * Strip the reaction suffix before calling Feishu message APIs.
 */
export function stripFeishuReactionSuffix(messageId: string): string {
  const trimmed = messageId.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.replace(FEISHU_REACTION_MESSAGE_ID_SUFFIX_RE, "");
}
