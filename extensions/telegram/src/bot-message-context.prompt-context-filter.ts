import type { TelegramPromptContextEntry } from "./bot-message-context.types.js";

/**
 * Decide whether a Telegram inbound message should suppress the
 * `chat_window` recent-conversation prompt-context block.
 *
 * The block injects the last ~10 cached Telegram messages on every inbound
 * turn. For Telegram private DMs that route to a persistent OpenClaw session,
 * the session transcript already contains that history, so the block
 * duplicates content and burns tokens on every turn (see issue #87566).
 *
 * Suppression is applied only when ALL of the following hold:
 *   - The chat is a private DM (not a group, supergroup, channel, or topic).
 *   - The chat has no message thread id (no Telegram forum / topic routing).
 *   - The route resolves to a session that already has prior activity
 *     (`previousTimestampMs` is set). The first inbound message in a fresh
 *     persistent session keeps the chat_window so the model still sees any
 *     pre-existing cached context.
 *
 * The function intentionally targets only `chat_window` entries — other
 * prompt-context kinds (if any are added later) flow through untouched.
 *
 * Reply / quote / forwarded context is propagated separately via
 * `extra.ReplyChain` and `supplemental.quote` / `supplemental.forwarded`, so
 * dropping `chat_window` here does NOT remove reply-chain context.
 */
export type TelegramPromptContextSuppressionInput = {
  /** True when the inbound chat is a Telegram group/supergroup/channel. */
  isGroup: boolean;
  /**
   * Resolved Telegram forum/topic id (if any). Topics behave like
   * sub-conversations and may carry chat_window even for private DMs that
   * have routed into a per-topic session.
   */
  threadId?: number | string | null;
  /**
   * Last-seen session timestamp for the resolved sessionKey. `undefined`
   * means the session has never been written to (fresh / non-persistent).
   */
  previousTimestampMs?: number | null;
};

export function shouldSuppressTelegramChatWindowPromptContext(
  input: TelegramPromptContextSuppressionInput,
): boolean {
  if (input.isGroup) return false;
  if (input.threadId != null && input.threadId !== "") return false;
  // No prior session activity → keep chat_window for fresh sessions.
  if (!input.previousTimestampMs || input.previousTimestampMs <= 0) return false;
  return true;
}

/**
 * Apply DM-persistent-session suppression to a Telegram prompt-context list.
 *
 * Only entries with `type === "chat_window"` are filtered. Other entry kinds
 * are returned unchanged. When suppression does not apply, the input array is
 * returned as-is.
 */
export function filterTelegramPromptContextForPersistentDm(
  entries: TelegramPromptContextEntry[],
  input: TelegramPromptContextSuppressionInput,
): TelegramPromptContextEntry[] {
  if (!shouldSuppressTelegramChatWindowPromptContext(input)) {
    return entries;
  }
  return entries.filter((entry) => entry?.type !== "chat_window");
}
