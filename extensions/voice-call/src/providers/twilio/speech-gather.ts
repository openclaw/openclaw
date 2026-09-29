// Voice Call plugin module implements Twilio speech <Gather> TwiML helpers.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { escapeXml } from "../../voice-mapping.js";

/** Twilio defaults to 5s; keep the call alive and re-prompt via Redirect on silence. */
export const TWILIO_SPEECH_GATHER_TIMEOUT_SEC = 120;

/** Same ceiling as the manager hangup timer, in seconds. */
const MAX_TWILIO_PAUSE_SEC = Math.floor(MAX_TIMER_TIMEOUT_MS / 1000);

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

/**
 * Verbs after `<Say>` when the call is not the conversation greeting.
 * Notify waits out `notifyHangupDelaySec`, then hangs up. Direct speech gathers
 * so Twilio does not complete the call the moment playback ends.
 */
export function buildTwilioSpeechOnlyTail(input: {
  webhookUrl: string;
  holdBeforeHangupSec?: number;
}): string {
  if (input.holdBeforeHangupSec != null) {
    return buildTwilioNotifyHoldVerbs(input.holdBeforeHangupSec);
  }
  return `  <Gather input="speech" speechTimeout="auto" action="${escapeXml(input.webhookUrl)}" method="POST">
  </Gather>`;
}

function buildTwilioNotifyHoldVerbs(holdSec: number): string {
  const pauseSec = normalizeTwilioPauseSeconds(holdSec);
  if (pauseSec <= 0) {
    return "  <Hangup/>";
  }
  return `  <Pause length="${pauseSec}"/>
  <Hangup/>`;
}

function normalizeTwilioPauseSeconds(holdSec: number): number {
  if (!Number.isFinite(holdSec) || holdSec <= 0) {
    return 0;
  }
  return Math.min(Math.floor(holdSec), MAX_TWILIO_PAUSE_SEC);
}
