import type { RcsInboundMessage } from "./types.js";

export function describeInboundBody(msg: RcsInboundMessage): string {
  const parts: string[] = [];
  if (msg.body) {
    parts.push(msg.body);
  }
  for (const mediaUrl of msg.mediaUrls) {
    parts.push(`[media] ${mediaUrl}`);
  }
  // A suggested-reply / postback tap with no display text still needs a visible
  // turn, so surface the opaque payload the user chose. When display text is
  // present it already conveys the choice; the raw payload stays in ctx extras.
  if (msg.buttonPayload && !msg.body) {
    parts.push(`[button] ${msg.buttonPayload}`);
  }
  return parts.join("\n");
}
