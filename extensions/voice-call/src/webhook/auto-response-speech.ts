// Voice Call module owns speech delivery for one automatic reply turn.

/** Minimal logging surface used while delivering an automatic reply. */
type AutoResponseSpeechLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

/** Speech delivery for one auto-response turn. */
export type AutoResponseSpeaker = {
  /** Speak one reply. Resolves true only when the caller actually heard it. */
  speak: (text: string) => Promise<boolean>;
  /**
   * Log a failed turn and tell the caller, unless they already heard something.
   * Speech that has been delivered must never be followed by an apology that
   * contradicts it, so a failure after a successful early handoff stays silent.
   */
  reportFailure: (logMessage: string, detail: string) => Promise<void>;
};

/**
 * Spoken notice for a turn whose response generation failed.
 *
 * Rate limiting is named specifically, so "try again in a little while" is
 * actionable rather than a guess.
 */
function generationFailureNotice(detail: string): string {
  return /\b429\b|rate.?limit|too many requests/i.test(detail)
    ? "Sorry, my language service is rate limited right now, so I can't answer that. Please try again in a little while."
    : "Sorry, I hit a problem working out a response. Please try again.";
}

/**
 * Build speech delivery for one auto-response turn.
 *
 * `speak` is handed to response generation as the early-text sink and is also
 * used for the final reply, so it owns the turn's delivery rules: a superseded
 * turn never speaks, because a newer caller utterance has taken ownership of
 * the call.
 *
 * Delivery is recorded here, at the point of delivery, rather than taken from
 * the generator's own view of itself. An early handoff can succeed before the
 * run later throws, and only the delivery site knows what the caller heard.
 */
export function createAutoResponseSpeaker(params: {
  callId: string;
  isCurrent: () => boolean;
  logger: AutoResponseSpeechLogger;
  deliver: (text: string) => Promise<{ success: boolean }>;
}): AutoResponseSpeaker {
  const { callId, isCurrent, logger, deliver } = params;
  let deliveredAnySpeech = false;

  const speak = async (text: string): Promise<boolean> => {
    if (!isCurrent()) {
      logger.info(`Discarding superseded automatic reply ${callId}`);
      return false;
    }
    logger.info(`AI response queued ${callId} chars=${text.length}`);
    const result = await deliver(text);
    if (result.success) {
      deliveredAnySpeech = true;
    }
    return result.success;
  };

  return {
    speak,
    reportFailure: async (logMessage: string, detail: string) => {
      logger.error(logMessage);
      if (deliveredAnySpeech) {
        return;
      }
      try {
        await speak(generationFailureNotice(detail));
      } catch (err) {
        logger.warn(`Failed to speak generation failure notice ${callId}: ${String(err)}`);
      }
    },
  };
}
