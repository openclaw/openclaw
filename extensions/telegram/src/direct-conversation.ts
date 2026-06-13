export type ParsedTelegramDirectConversation = {
  userId: string;
  canonicalConversationId: string;
};

/**
 * Parses a Telegram direct (1:1) conversation id into its canonical form.
 *
 * Accepts either a bare positive peer id (the shape inbound DMs use, e.g.
 * `8517390162`) or an explicit `direct:<userId>` config form. Both normalize to
 * the bare positive id so a configured binding compiles to the same id the
 * inbound route produces (compile-id == inbound-id).
 *
 * Group/topic ids (negative chat ids, `:topic:` forms) return null so they keep
 * flowing through the topic matcher instead.
 */
export function parseTelegramDirectConversation(params: {
  conversationId: string;
}): ParsedTelegramDirectConversation | null {
  const raw = params.conversationId.trim();
  if (!raw) {
    return null;
  }
  const directMatch = raw.match(/^direct:(\d+)$/i);
  const userId = directMatch?.[1] ?? raw;
  if (!/^\d+$/.test(userId)) {
    return null;
  }
  return {
    userId,
    canonicalConversationId: userId,
  };
}
