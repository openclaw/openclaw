// Voice Call plugin module implements Twilio speech <Gather> TwiML helpers.
import { escapeXml } from "../../voice-mapping.js";

/** Twilio defaults to 5s; keep the call alive and re-prompt via Redirect on silence. */
export const TWILIO_SPEECH_GATHER_TIMEOUT_SEC = 120;

export function buildTwilioSpeechGatherVerbs(input: {
  webhookUrl: string;
  language?: string;
  turnToken?: string;
}): string {
  const actionUrl = new URL(input.webhookUrl);
  if (input.turnToken) {
    actionUrl.searchParams.set("turnToken", input.turnToken);
  }
  const language = input.language || "en-US";
  return `  <Gather input="speech" speechTimeout="auto" timeout="${TWILIO_SPEECH_GATHER_TIMEOUT_SEC}" language="${escapeXml(language)}" action="${escapeXml(actionUrl.toString())}" method="POST">
  </Gather>
  <Redirect method="POST">${escapeXml(input.webhookUrl)}</Redirect>`;
}
