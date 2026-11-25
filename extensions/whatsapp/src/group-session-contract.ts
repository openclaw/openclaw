// Whatsapp plugin module implements group session contract behavior.
import { canonicalizeWhatsAppGroupJid } from "./whatsapp-jid-syntax.js";

export function resolveLegacyGroupSessionKey(ctx: { From?: string }): {
  key: string;
  channel: string;
  id: string;
  chatType: "group";
} | null {
  const groupJid = canonicalizeWhatsAppGroupJid(ctx.From);
  if (!groupJid) {
    return null;
  }
  return {
    key: `whatsapp:group:${groupJid}`,
    channel: "whatsapp",
    id: groupJid,
    chatType: "group",
  };
}
