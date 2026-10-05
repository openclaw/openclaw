import { z } from "zod";

/** Opening question used by the explicit realtime consent flow. */
export const REALTIME_VOICE_CONSENT_QUESTION = "Do you consent to this call being recorded?";

const CONSENT_TOPIC = /\bconsent\b/i;
const RECORDING_TOPIC = /\brecord/i;

/**
 * True when a completed assistant turn is the opening recording-consent question rather than some
 * other opening remark. The watchdog must arm only after the question was actually asked, so a
 * provider that opens with something else -- or merely states a recording policy, such as
 * "We require consent for recording." -- cannot have a live call ended on silence.
 *
 * The turn must be question-shaped: either the canonical question verbatim, or a turn that both
 * names the consent and recording topics and is actually interrogative (carries a question mark or
 * opens on an interrogative word). A declarative statement about consent never matches.
 */
export function isConsentQuestionUtterance(transcript: string): boolean {
  const text = transcript.trim();
  if (!text) {
    return false;
  }
  if (text.includes(REALTIME_VOICE_CONSENT_QUESTION)) {
    return true;
  }
  return isInterrogative(text) && CONSENT_TOPIC.test(text) && RECORDING_TOPIC.test(text);
}

const INTERROGATIVE_LEAD =
  /^(?:do|does|did|are|is|am|was|were|can|could|would|will|may|might|shall|should|have|has|had|who|what|when|where|why|how|which|whose|whom)\b/i;

/** True when a turn reads as a question, by trailing question mark or interrogative opening. */
function isInterrogative(text: string): boolean {
  return text.includes("?") || INTERROGATIVE_LEAD.test(text);
}

export const VoiceCallRealtimeConsentWindowConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    windowMs: z.number().int().positive().default(5000),
  })
  .strict()
  .default({ enabled: false, windowMs: 5000 });
