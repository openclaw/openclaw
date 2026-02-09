import { escapeXml } from "../voice-mapping.js";

export function generateNotifyTwiml(message: string, voice: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${escapeXml(voice)}">${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
}
