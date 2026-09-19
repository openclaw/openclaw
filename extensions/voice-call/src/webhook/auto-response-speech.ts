// Voice Call module owns speech delivery for one automatic reply turn.

/** Minimal logging surface used while delivering an automatic reply. */
type AutoResponseSpeechLogger = {
  info: (message: string) => void;
};

/**
 * Build the speech callback for one auto-response turn.
 *
 * The returned callback is handed to response generation as the early-text
 * sink and is also used for the final reply, so it owns two delivery rules for
 * the turn:
 *
 * - A superseded turn never speaks, because a newer caller utterance has
 *   already taken ownership of the call.
 * - Text already delivered in this turn is not spoken twice. A long reply keeps
 *   playback in flight long enough that a second delivery event (run
 *   completion, or a later flush) can request the identical text again.
 *
 * Duplicate suppression is committed only after delivery succeeds. A failed
 * early attempt must leave the final path free to speak the same text,
 * otherwise a failure to play early silently becomes "already said that" and
 * the caller hears nothing at all for the turn.
 */
export function createAutoResponseSpeaker(params: {
  callId: string;
  isCurrent: () => boolean;
  logger: AutoResponseSpeechLogger;
  deliver: (text: string) => Promise<{ success: boolean }>;
}): (text: string) => Promise<boolean> {
  const { callId, isCurrent, logger, deliver } = params;
  let deliveredText: string | null = null;

  return async (text: string): Promise<boolean> => {
    if (!isCurrent()) {
      logger.info(`Discarding superseded automatic reply ${callId}`);
      return false;
    }
    if (deliveredText === text) {
      logger.info(`Skipping duplicate automatic reply ${callId} chars=${text.length}`);
      return true;
    }
    logger.info(`AI response queued ${callId} chars=${text.length}`);
    const result = await deliver(text);
    if (result.success) {
      deliveredText = text;
    }
    return result.success;
  };
}
