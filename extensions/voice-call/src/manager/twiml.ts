import { escapeXml } from "../voice-mapping.js";

/** Render a terminal Twilio TwiML response that speaks an escaped status message and hangs up. */
export function generateNotifyTwiml(message: string, voice: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
}

/** Render Twilio TwiML that sends escaped DTMF digits before returning to the webhook. */
export function generateDtmfRedirectTwiml(digits: string, webhookUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play digits="${escapeXml(digits)}" />
  <Redirect method="POST">${escapeXml(webhookUrl)}</Redirect>
</Response>`;
}
