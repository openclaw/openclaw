/**
 * Inbound message debouncer: coalesces rapid messages from the same sender
 * in the same conversation before dispatching to the AI agent.
 *
 * This prevents wasted tokens when a user sends multiple messages in quick
 * succession (e.g., 3 messages in 2 seconds) — each would otherwise trigger
 * a separate AI dispatch.
 */

export type PendingMessage = { text: string; messageId: string };

export type DebouncerEntry = {
  timer: ReturnType<typeof setTimeout>;
  messages: PendingMessage[];
};

export function createInboundDebouncer(delayMs: number = 1500) {
  const pending = new Map<string, DebouncerEntry>();

  return {
    /**
     * Queue a message for debounced dispatch.
     * @param key - Unique key, typically `${conversationId}:${senderId}`
     * @param text - Message text
     * @param messageId - Original message ID
     * @param dispatch - Called after the debounce window with combined text and all message IDs
     */
    debounce(
      key: string,
      text: string,
      messageId: string,
      dispatch: (combinedText: string, messageIds: string[]) => void,
    ) {
      const entry = pending.get(key);
      if (entry) {
        clearTimeout(entry.timer);
        entry.messages.push({ text, messageId });
      } else {
        pending.set(key, {
          timer: null as unknown as ReturnType<typeof setTimeout>,
          messages: [{ text, messageId }],
        });
      }
      const e = pending.get(key)!;
      e.timer = setTimeout(() => {
        pending.delete(key);
        dispatch(
          e.messages.map((m) => m.text).join("\n"),
          e.messages.map((m) => m.messageId),
        );
      }, delayMs);
    },

    /** Cancel and remove a pending debounce entry. */
    clear(key: string) {
      const entry = pending.get(key);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(key);
      }
    },

    /** Number of pending debounce entries (for testing/monitoring). */
    get size() {
      return pending.size;
    },
  };
}
