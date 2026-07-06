import type { IncomingWhatsAppMessage } from "./types.js";

export function mapWhatsAppToInbound(m: IncomingWhatsAppMessage) {
  return {
    channel: "whatsapp",
    channelId: m.from,
    text: m.text ?? "",
    externalId: m.id,
    raw: m.raw
  };
}
