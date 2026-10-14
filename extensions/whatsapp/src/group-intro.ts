import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";

export function resolveWhatsAppMentionStripRegexes(ctx: { To?: string | null }): RegExp[] {
  const selfE164 = (ctx.To ?? "").replace(/^whatsapp:/i, "");
  if (!selfE164) {
    return [];
  }
  const escaped = escapeRegExp(selfE164);
  return [new RegExp(escaped, "g"), new RegExp(`@${escaped}`, "g")];
}
